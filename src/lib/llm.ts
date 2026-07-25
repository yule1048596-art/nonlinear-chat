import type { ChatMessage, Profile } from '../types';

export interface StreamChunk {
  /** 正文增量 */
  delta?: string;
  /** 推理增量（DeepSeek-R1 / 部分网关会给 reasoning_content） */
  reasoning?: string;
  usage?: { prompt?: number; completion?: number };
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`;
}

/** 网络层失败在浏览器里一律是 TypeError，最常见的原因就是 CORS，给用户一句人话 */
function describeNetworkFailure(baseUrl: string): LlmError {
  return new LlmError(
    '连不上接口',
    undefined,
    `无法访问 ${baseUrl}。常见原因：① 该服务不允许浏览器跨域直连（CORS）；` +
      `② base URL 填错了；③ 断网或被代理拦截。若是本地 Ollama，启动时需设置 OLLAMA_ORIGINS=*。`,
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
    /* 不是 JSON 就直接回显原文 */
  }
  return raw.slice(0, 400);
}

function hintForStatus(status: number): string | undefined {
  if (status === 401 || status === 403) return 'API Key 无效或没有该模型的权限，去设置里检查 Key。';
  if (status === 404) return 'base URL 或模型名不对。多数服务的 base URL 需要以 /v1 结尾。';
  if (status === 429) return '触发限流或余额不足，等一会儿再试。';
  if (status >= 500) return '服务端错误，通常重试即可。';
  return undefined;
}

/**
 * OpenAI 兼容的流式补全。
 * 只要服务实现了 /chat/completions 的 SSE 协议就能用：
 * OpenAI、DeepSeek、OpenRouter、硅基流动、Moonshot、智谱、Ollama…
 */
export async function* streamChat(
  profile: Profile,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const body: Record<string, unknown> = {
    model: profile.model,
    messages,
    stream: true,
    // 有的网关要显式开启才回传 usage，不支持的会忽略这个字段
    stream_options: { include_usage: true },
  };
  if (typeof profile.temperature === 'number') body.temperature = profile.temperature;
  if (profile.maxTokens) body.max_tokens = profile.maxTokens;

  let res: Response;
  try {
    res = await fetch(joinUrl(profile.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw describeNetworkFailure(profile.baseUrl);
  }

  if (!res.ok) {
    throw new LlmError(await readErrorBody(res), res.status, hintForStatus(res.status));
  }
  if (!res.body) throw new LlmError('响应没有 body，该服务可能不支持流式输出');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔；\r\n\r\n 是为了兼容某些反代
      let sep: number;
      while ((sep = findEventEnd(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '');

        const payload = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');

        if (!payload) continue;
        if (payload === '[DONE]') return;

        let json: any;
        try {
          json = JSON.parse(payload);
        } catch {
          continue; // 半包或心跳，跳过
        }

        // 有些服务会把错误塞在 200 的流里
        if (json.error) {
          throw new LlmError(json.error.message ?? String(json.error));
        }

        const choice = json.choices?.[0];
        const delta = choice?.delta ?? {};
        const chunk: StreamChunk = {};
        if (typeof delta.content === 'string' && delta.content) chunk.delta = delta.content;
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          chunk.reasoning = delta.reasoning_content;
        } else if (typeof delta.reasoning === 'string' && delta.reasoning) {
          chunk.reasoning = delta.reasoning;
        }
        if (json.usage) {
          chunk.usage = {
            prompt: json.usage.prompt_tokens,
            completion: json.usage.completion_tokens,
          };
        }
        if (chunk.delta || chunk.reasoning || chunk.usage) yield chunk;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function findEventEnd(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/** 拉取可用模型列表，给设置面板做下拉用 */
export async function listModels(profile: Pick<Profile, 'baseUrl' | 'apiKey'>): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(joinUrl(profile.baseUrl, '/models'), {
      headers: profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {},
    });
  } catch {
    throw describeNetworkFailure(profile.baseUrl);
  }
  if (!res.ok) {
    throw new LlmError(await readErrorBody(res), res.status, hintForStatus(res.status));
  }
  const json = await res.json();
  const list: unknown[] = json?.data ?? json?.models ?? [];
  return list
    .map((item: any) => (typeof item === 'string' ? item : (item?.id ?? item?.name)))
    .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
    .sort();
}

export const PRESETS: Array<{ name: string; baseUrl: string; model: string }> = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5' },
  { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-72B-Instruct' },
  { name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  { name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5' },
];
