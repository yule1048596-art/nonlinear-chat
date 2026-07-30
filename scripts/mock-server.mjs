/**
 * 假的 OpenAI 兼容服务端，用来验证 DAG 上下文拼装。
 *
 *   node scripts/mock-server.mjs
 *   设置 → Base URL 填 http://localhost:8787/v1，Key 随便填
 *
 * 它把收到的完整 messages 数组原样回显成 Markdown，并打印到终端。
 * 这是验证「多父合并后上下文顺序对不对」唯一可靠的手段——光看界面
 * 看不出发给模型的到底是什么。
 */
import http from 'node:http';

const PORT = 8787;
/** 每片之间的间隔。调大用来手动验证「生成到一半切画布/删画布」这类竞态 */
const DELAY = Number(process.env.MOCK_DELAY_MS ?? 12);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

http
  .createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end();

    if (req.url.endsWith('/models')) {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-fast' }, { id: 'mock-smart' }] }));
    }

    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404, CORS);
      return res.end('not found');
    }

    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const msgs = body.messages ?? [];

    console.log('\n=== 收到请求 ===');
    console.log(`model: ${body.model} | temp: ${body.temperature} | max_tokens: ${body.max_tokens}`);
    msgs.forEach((m, i) => console.log(`  [${i}] ${m.role}: ${JSON.stringify(m.content)}`));

    const reply =
      `收到 **${msgs.length}** 条消息：\n\n` +
      msgs.map((m, i) => `${i + 1}. \`${m.role}\` — ${m.content}`).join('\n') +
      '\n\n```js\nconst ok = true;\n```';

    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // 先吐一段 reasoning，顺便验证 reasoning_content 有没有被正确分流
    send({ choices: [{ delta: { reasoning_content: `模型 ${body.model} 正在思考…` } }] });

    // 按片发送，逼近真实的流式体验。
    // MOCK_DELAY_MS 调慢是为了能手动验证「生成到一半切画布」这类竞态。
    const step = 7;
    for (let i = 0; i < reply.length; i += step) {
      send({ choices: [{ delta: { content: reply.slice(i, i + step) } }] });
      await new Promise((r) => setTimeout(r, DELAY));
    }

    send({
      choices: [{ delta: {} }],
      usage: { prompt_tokens: msgs.length * 11, completion_tokens: reply.length },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  })
  .listen(PORT, () => console.log(`mock OpenAI-compatible server → http://localhost:${PORT}/v1`));
