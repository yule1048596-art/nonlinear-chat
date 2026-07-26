import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmError, listModels, streamChat } from './llm';
import type { Profile } from '../types';

const profile: Profile = {
  id: 'p',
  name: 'test',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  temperature: 0.7,
};

/** 把若干片段拼成一个 SSE 流。片段边界刻意可控，用来构造半包 */
function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, ...init });
}

const event = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (content: string) => event({ choices: [{ delta: { content } }] });

async function collect(gen: AsyncGenerator<{ delta?: string; reasoning?: string; usage?: unknown }>) {
  const out = { content: '', reasoning: '', usage: undefined as unknown };
  for await (const chunk of gen) {
    if (chunk.delta) out.content += chunk.delta;
    if (chunk.reasoning) out.reasoning += chunk.reasoning;
    if (chunk.usage) out.usage = chunk.usage;
  }
  return out;
}

const mockFetch = (impl: typeof fetch) => vi.stubGlobal('fetch', impl);

afterEach(() => vi.unstubAllGlobals());

describe('streamChat', () => {
  it('把多个事件的正文拼起来', async () => {
    mockFetch(async () => sseResponse([delta('你好'), delta('，'), delta('世界'), 'data: [DONE]\n\n']));
    const got = await collect(streamChat(profile, [{ role: 'user', content: 'hi' }]));
    expect(got.content).toBe('你好，世界');
  });

  /**
   * 这是 SSE 解析最容易写错的地方：网络分片不会对齐事件边界，
   * 一个 JSON 可能被切成两半分两次到达，缓冲没做对就会丢字符或抛解析错。
   */
  it('事件被切成半包也能正确还原', async () => {
    const whole = delta('半包测试');
    const cut = Math.floor(whole.length / 2);
    mockFetch(async () => sseResponse([whole.slice(0, cut), whole.slice(cut), 'data: [DONE]\n\n']));
    const got = await collect(streamChat(profile, []));
    expect(got.content).toBe('半包测试');
  });

  it('一次到达多个事件也能全部解析', async () => {
    mockFetch(async () => sseResponse([delta('a') + delta('b') + delta('c')]));
    expect((await collect(streamChat(profile, []))).content).toBe('abc');
  });

  it('[DONE] 之后的内容不再处理', async () => {
    mockFetch(async () => sseResponse([delta('前'), 'data: [DONE]\n\n', delta('后')]));
    expect((await collect(streamChat(profile, []))).content).toBe('前');
  });

  it('兼容 CRLF 分隔符（某些反代会改写）', async () => {
    mockFetch(async () =>
      sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: 'crlf' } }] })}\r\n\r\n`]),
    );
    expect((await collect(streamChat(profile, []))).content).toBe('crlf');
  });

  it('reasoning_content 走 reasoning，不混进正文', async () => {
    mockFetch(async () =>
      sseResponse([
        event({ choices: [{ delta: { reasoning_content: '思考中' } }] }),
        delta('答案'),
      ]),
    );
    const got = await collect(streamChat(profile, []));
    expect(got.reasoning).toBe('思考中');
    expect(got.content).toBe('答案');
  });

  it('也认 reasoning 字段（网关命名不统一）', async () => {
    mockFetch(async () => sseResponse([event({ choices: [{ delta: { reasoning: 'r' } }] })]));
    expect((await collect(streamChat(profile, []))).reasoning).toBe('r');
  });

  it('usage 被透传出来', async () => {
    mockFetch(async () =>
      sseResponse([delta('x'), event({ choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 22 } })]),
    );
    expect((await collect(streamChat(profile, []))).usage).toEqual({ prompt: 11, completion: 22 });
  });

  it('跳过心跳和空行，不报错', async () => {
    mockFetch(async () => sseResponse([': ping\n\n', '\n\n', delta('ok')]));
    expect((await collect(streamChat(profile, []))).content).toBe('ok');
  });

  it('无法解析的 data 被跳过而不是中断整个流', async () => {
    mockFetch(async () => sseResponse(['data: {不是合法JSON\n\n', delta('后续照常')]));
    expect((await collect(streamChat(profile, []))).content).toBe('后续照常');
  });

  /** 有的服务返回 200，却把错误塞在流里 */
  it('200 响应里夹 error 也要抛出来', async () => {
    mockFetch(async () => sseResponse([event({ error: { message: '额度不足' } })]));
    await expect(collect(streamChat(profile, []))).rejects.toThrow('额度不足');
  });

  it('非 200 抛 LlmError 并带上状态码与排查提示', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }),
    );
    const err = await collect(streamChat(profile, [])).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.status).toBe(401);
    expect(err.message).toContain('Invalid API key');
    expect(err.hint).toContain('Key');
  });

  it('429 和 5xx 各自给出对应提示', async () => {
    mockFetch(async () => new Response('slow down', { status: 429 }));
    expect((await collect(streamChat(profile, [])).catch((e) => e)).hint).toContain('限流');

    mockFetch(async () => new Response('boom', { status: 503 }));
    expect((await collect(streamChat(profile, [])).catch((e) => e)).hint).toContain('重试');
  });

  it('404 提示 base URL 或模型名不对', async () => {
    mockFetch(async () => new Response('nope', { status: 404 }));
    expect((await collect(streamChat(profile, [])).catch((e) => e)).hint).toContain('base URL');
  });

  /** 浏览器里 CORS 失败一律是裸 TypeError，必须翻译成人话 */
  it('网络层失败给出 CORS 排查提示而不是裸 TypeError', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await collect(streamChat(profile, [])).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.hint).toContain('CORS');
    expect(err.hint).toContain(profile.baseUrl);
  });

  it('AbortError 原样抛出，不被当成网络故障', async () => {
    mockFetch(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const err = await collect(streamChat(profile, [])).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(LlmError);
  });

  it('请求体里带上模型、温度和 max_tokens', async () => {
    let body: Record<string, unknown> = {};
    mockFetch(async (_url, init) => {
      body = JSON.parse(String((init as RequestInit).body));
      return sseResponse(['data: [DONE]\n\n']);
    });
    await collect(streamChat({ ...profile, maxTokens: 512 }, [{ role: 'user', content: 'hi' }]));
    expect(body).toMatchObject({ model: 'test-model', temperature: 0.7, max_tokens: 512, stream: true });
  });

  it('baseUrl 末尾多余的斜杠会被规整掉', async () => {
    let url = '';
    mockFetch(async (u) => {
      url = String(u);
      return sseResponse(['data: [DONE]\n\n']);
    });
    await collect(streamChat({ ...profile, baseUrl: 'https://api.example.com/v1///' }, []));
    expect(url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('没填 Key 时不发 Authorization 头（本地 Ollama 用得上）', async () => {
    let headers: Record<string, string> = {};
    mockFetch(async (_u, init) => {
      headers = (init as RequestInit).headers as Record<string, string>;
      return sseResponse(['data: [DONE]\n\n']);
    });
    await collect(streamChat({ ...profile, apiKey: '' }, []));
    expect(headers.Authorization).toBeUndefined();
  });
});

describe('listModels', () => {
  it('从 data 数组里取出并排序模型 id', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ data: [{ id: 'zeta' }, { id: 'alpha' }] }), { status: 200 }),
    );
    expect(await listModels(profile)).toEqual(['alpha', 'zeta']);
  });

  it('兼容 models 字段和纯字符串数组', async () => {
    mockFetch(async () => new Response(JSON.stringify({ models: ['b', 'a'] }), { status: 200 }));
    expect(await listModels(profile)).toEqual(['a', 'b']);
  });

  it('过滤掉没有 id 的条目', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ data: [{ id: 'ok' }, { foo: 1 }, null] }), { status: 200 }),
    );
    expect(await listModels(profile)).toEqual(['ok']);
  });

  it('失败时同样给出可操作的提示', async () => {
    mockFetch(async () => new Response('nope', { status: 401 }));
    const err = await listModels(profile).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.hint).toContain('Key');
  });
});
