import { isLocalUrl, usesLoopbackIp } from './endpoint';
import { isNormalized } from './knowledge';

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 一次请求塞多少条。
 * llama-server 的 batch/context 有上限，一次几百条会直接失败或超时；
 * 16 条在本地 bge-m3 上既不慢也不容易撞上限。
 */
export const BATCH_SIZE = 16;

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`;
}

/**
 * 网络层失败在浏览器里一律是裸 TypeError，这里翻译成人话。
 * 本地服务最常见的三种死法都点名，尤其是 127.0.0.1 那条 ——
 * 部署在 https 上的页面访问 http://127.0.0.1 会被混合内容策略拦掉，
 * 但写成 localhost 就放行（实测过），不说明的话没人猜得到。
 */
function describeNetworkFailure(baseUrl: string): EmbeddingError {
  if (!isLocalUrl(baseUrl)) {
    return new EmbeddingError(
      '连不上向量服务',
      `无法访问 ${baseUrl}。可能是服务不允许浏览器跨域（CORS），或者地址填错了。`,
    );
  }
  return new EmbeddingError(
    '连不上本地向量服务',
    [
      `无法访问 ${baseUrl}。`,
      usesLoopbackIp(baseUrl)
        ? '⚠️ 地址里写的是 127.0.0.1 —— 请改成 localhost。https 页面访问 http://127.0.0.1 会被浏览器的混合内容策略拦掉，而 localhost 属于可信来源不受限。'
        : '请确认本地服务正在运行。',
      '若用 llama.cpp：确认模型文件所在的磁盘已挂载，服务已启动。',
    ].join('\n'),
  );
}

async function readErrorBody(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  if (!raw) return res.statusText || `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof message === 'string' && message) return message;
  } catch {
    /* 不是 JSON 就回显原文 */
  }
  return raw.slice(0, 300);
}

function hintForStatus(status: number): string | undefined {
  if (status === 401 || status === 403) return 'API Key 不对。llama-server 的 Key 由 --api-key 指定。';
  if (status === 404) return 'base URL 或模型名不对。地址通常要以 /v1 结尾。';
  if (status === 400) return '模型名可能不对，或者输入超出了模型的长度上限。';
  if (status >= 500) return '服务端错误。若用 llama.cpp，看一眼它的日志。';
  return undefined;
}

/** 单批请求 */
async function embedBatch(
  config: EmbeddingConfig,
  inputs: string[],
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  let res: Response;
  try {
    res = await fetch(joinUrl(config.baseUrl, '/embeddings'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input: inputs }),
      signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw describeNetworkFailure(config.baseUrl);
  }

  if (!res.ok) {
    throw new EmbeddingError(await readErrorBody(res), hintForStatus(res.status));
  }

  const json = await res.json();
  const data: unknown[] = json?.data ?? [];
  if (!Array.isArray(data) || data.length !== inputs.length) {
    throw new EmbeddingError(
      `向量服务返回了 ${Array.isArray(data) ? data.length : 0} 条，但请求的是 ${inputs.length} 条`,
      '响应格式和 OpenAI 的 /v1/embeddings 不一致。',
    );
  }

  // 有的服务不保证返回顺序，按 index 归位；没有 index 就按原顺序
  const out: Float32Array[] = new Array(inputs.length);
  data.forEach((item: any, i: number) => {
    const vector = item?.embedding;
    if (!Array.isArray(vector)) throw new EmbeddingError('响应里没有 embedding 数组');
    const at = typeof item?.index === 'number' ? item.index : i;
    out[at] = new Float32Array(vector);
  });
  return out;
}

export interface EmbedProgress {
  done: number;
  total: number;
}

/**
 * 批量求向量。分批发送并回报进度，建大库时用户能看见在动。
 *
 * 会校验第一条结果是否 L2 归一化 —— 检索靠点积等于余弦这个前提，
 * 前提不成立时排序会失真。与其安静地给出错的结果，不如直接报出来。
 */
export async function embedAll(
  config: EmbeddingConfig,
  inputs: string[],
  options: { signal?: AbortSignal; onProgress?: (p: EmbedProgress) => void } = {},
): Promise<Float32Array[]> {
  if (inputs.length === 0) return [];

  const out: Float32Array[] = [];
  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const batch = inputs.slice(i, i + BATCH_SIZE);
    const vectors = await embedBatch(config, batch, options.signal);

    if (i === 0 && vectors[0] && !isNormalized(vectors[0])) {
      throw new EmbeddingError(
        '向量没有归一化，检索结果会不准',
        'llama.cpp 请加上 --embd-normalize 2 再启动。检索用点积代替余弦相似度，这一步是前提。',
      );
    }

    out.push(...vectors);
    options.onProgress?.({ done: out.length, total: inputs.length });
  }
  return out;
}

/** 求单条向量，检索时给问题用 */
export async function embedOne(
  config: EmbeddingConfig,
  input: string,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const [vector] = await embedBatch(config, [input], signal);
  if (!vector) throw new EmbeddingError('向量服务没有返回结果');
  return vector;
}

/** 本地 llama.cpp 跑 bge-m3 的默认配置 */
export const DEFAULT_EMBEDDING: EmbeddingConfig = {
  // 必须是 localhost 而不是 127.0.0.1，见 describeNetworkFailure 的说明
  baseUrl: 'http://localhost:8081/v1',
  apiKey: '',
  model: 'text-embedding-bge-m3',
};
