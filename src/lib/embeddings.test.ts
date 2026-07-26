import { afterEach, describe, expect, it, vi } from 'vitest';
import { BATCH_SIZE, EmbeddingError, embedAll, embedOne } from './embeddings';
import type { EmbeddingConfig } from './embeddings';

const config: EmbeddingConfig = {
  baseUrl: 'http://localhost:8081/v1',
  apiKey: 'local-llama',
  model: 'text-embedding-bge-m3',
};

/** 造一条 L2 归一化的假向量，内容由 seed 决定 */
const unitVector = (seed: number, dim = 4): number[] => {
  const raw = Array.from({ length: dim }, (_, i) => Math.sin(seed + i) + 1.5);
  const m = Math.sqrt(raw.reduce((s, x) => s + x * x, 0));
  return raw.map((x) => x / m);
};

const okResponse = (inputs: string[], opts: { shuffle?: boolean; normalized?: boolean } = {}) => {
  const data = inputs.map((_, i) => ({
    index: i,
    embedding: opts.normalized === false ? [3, 4, 0, 0] : unitVector(i),
  }));
  if (opts.shuffle) data.reverse();
  return new Response(JSON.stringify({ data, model: config.model }), { status: 200 });
};

const mockFetch = (impl: typeof fetch) => vi.stubGlobal('fetch', impl);
afterEach(() => vi.unstubAllGlobals());

describe('embedAll', () => {
  it('空输入不发请求', async () => {
    const spy = vi.fn();
    mockFetch(spy as unknown as typeof fetch);
    expect(await embedAll(config, [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('返回和输入等量的向量', async () => {
    mockFetch(async (_u, init) => okResponse(JSON.parse(String((init as RequestInit).body)).input));
    const out = await embedAll(config, ['一', '二', '三']);
    expect(out).toHaveLength(3);
    expect(out[0]).toBeInstanceOf(Float32Array);
  });

  /** 一次几百条会撞上 llama-server 的 batch 上限，必须分批 */
  it('超过批量上限时分多次请求', async () => {
    let calls = 0;
    mockFetch(async (_u, init) => {
      calls++;
      return okResponse(JSON.parse(String((init as RequestInit).body)).input);
    });
    const inputs = Array.from({ length: BATCH_SIZE * 2 + 3 }, (_, i) => `第${i}条`);
    const out = await embedAll(config, inputs);
    expect(out).toHaveLength(inputs.length);
    expect(calls).toBe(3);
  });

  it('回报进度，建大库时用户能看见在动', async () => {
    mockFetch(async (_u, init) => okResponse(JSON.parse(String((init as RequestInit).body)).input));
    const seen: number[] = [];
    const inputs = Array.from({ length: BATCH_SIZE + 1 }, (_, i) => `x${i}`);
    await embedAll(config, inputs, { onProgress: (p) => seen.push(p.done) });
    expect(seen).toEqual([BATCH_SIZE, BATCH_SIZE + 1]);
  });

  /** 有的服务不保证返回顺序，错位会让每个块配上别人的向量 */
  it('按 index 归位，乱序返回也不会张冠李戴', async () => {
    mockFetch(async (_u, init) =>
      okResponse(JSON.parse(String((init as RequestInit).body)).input, { shuffle: true }),
    );
    const out = await embedAll(config, ['甲', '乙', '丙']);
    expect(Array.from(out[0]!)).toEqual(unitVector(0).map((x) => Math.fround(x)));
    expect(Array.from(out[2]!)).toEqual(unitVector(2).map((x) => Math.fround(x)));
  });

  /**
   * 检索靠「点积等于余弦」这个前提，向量没归一化时排序会失真。
   * 与其安静地给出错的结果，不如直接报出来。
   */
  it('向量没归一化时报错并指出该加哪个参数', async () => {
    mockFetch(async (_u, init) =>
      okResponse(JSON.parse(String((init as RequestInit).body)).input, { normalized: false }),
    );
    const err = await embedAll(config, ['x']).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err.hint).toContain('--embd-normalize');
  });

  it('返回条数对不上时报错，不静默错位', async () => {
    mockFetch(async () => new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 }));
    await expect(embedAll(config, ['甲', '乙'])).rejects.toThrow('但请求的是 2 条');
  });

  it('响应里没有 embedding 数组时报错', async () => {
    mockFetch(async () => new Response(JSON.stringify({ data: [{ foo: 1 }] }), { status: 200 }));
    await expect(embedAll(config, ['x'])).rejects.toThrow('embedding');
  });
});

describe('错误归因', () => {
  it('401 指向 llama-server 的 --api-key', async () => {
    mockFetch(async () => new Response('{"error":"unauthorized"}', { status: 401 }));
    const err = await embedOne(config, 'x').catch((e) => e);
    expect(err.hint).toContain('--api-key');
  });

  it('404 提示 base URL 或模型名', async () => {
    mockFetch(async () => new Response('nope', { status: 404 }));
    expect((await embedOne(config, 'x').catch((e) => e)).hint).toContain('base URL');
  });

  it('400 提示模型名或长度超限', async () => {
    mockFetch(async () => new Response('{"error":"bad"}', { status: 400 }));
    expect((await embedOne(config, 'x').catch((e) => e)).hint).toContain('长度上限');
  });

  it('本地服务连不上时提示检查服务和磁盘挂载', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await embedOne(config, 'x').catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err.hint).toContain('挂载');
  });

  /**
   * 这条是实测出来的坑：https 页面访问 http://127.0.0.1 会被混合内容策略拦，
   * 但写 localhost 就放行。不点名的话没人猜得到。
   */
  it('地址写成 127.0.0.1 时明确提示改用 localhost', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await embedOne({ ...config, baseUrl: 'http://127.0.0.1:8081/v1' }, 'x').catch((e) => e);
    expect(err.hint).toContain('localhost');
    expect(err.hint).toContain('混合内容');
  });

  it('远程服务连不上时提示 CORS 而不是本地服务', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await embedOne({ ...config, baseUrl: 'https://api.example.com/v1' }, 'x').catch((e) => e);
    expect(err.hint).toContain('CORS');
    expect(err.hint).not.toContain('挂载');
  });

  it('AbortError 原样抛出，不当成网络故障', async () => {
    mockFetch(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const err = await embedOne(config, 'x').catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(EmbeddingError);
  });
});

describe('请求构造', () => {
  it('把 model 和 input 数组发过去，URL 末尾斜杠会规整', async () => {
    let url = '';
    let body: any = {};
    mockFetch(async (u, init) => {
      url = String(u);
      body = JSON.parse(String((init as RequestInit).body));
      return okResponse(body.input);
    });
    await embedAll({ ...config, baseUrl: 'http://localhost:8081/v1//' }, ['甲', '乙']);
    expect(url).toBe('http://localhost:8081/v1/embeddings');
    expect(body).toMatchObject({ model: config.model, input: ['甲', '乙'] });
  });

  it('没填 Key 时不发 Authorization 头', async () => {
    let headers: Record<string, string> = {};
    mockFetch(async (_u, init) => {
      headers = (init as RequestInit).headers as Record<string, string>;
      return okResponse(['x']);
    });
    await embedOne({ ...config, apiKey: '' }, 'x');
    expect(headers.Authorization).toBeUndefined();
  });
});
