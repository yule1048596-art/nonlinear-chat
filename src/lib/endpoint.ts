/**
 * 端点地址的判断。
 *
 * 被聊天客户端、向量客户端和设置界面三处共用 —— 这套规则原来在
 * embeddings.ts 里是内联正则，多一处用就多一份走样的机会。
 */

/**
 * 本地回环地址。
 *
 * 这类服务通常不需要 API Key，所以「没填 Key」的拦截会放它过去。
 */
export function isLocalUrl(url: string): boolean {
  return /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url.trim());
}

/**
 * 用的是回环 IP 而不是 localhost。
 *
 * 这是实测出来的坑：部署在 https 上的页面访问 http://127.0.0.1 会被浏览器的
 * 混合内容策略拦掉，而 localhost 属于「潜在可信来源」不受此限。
 * 两个地址指向同一个服务，行为却不一样，不点名没人猜得到。
 */
export function usesLoopbackIp(url: string): boolean {
  return /(^|\/\/)(127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url.trim());
}
