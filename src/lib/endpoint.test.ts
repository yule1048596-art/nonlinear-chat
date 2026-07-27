import { describe, expect, it } from 'vitest';
import { isLocalUrl, usesLoopbackIp } from './endpoint';

describe('isLocalUrl', () => {
  it('认得各种本地写法', () => {
    expect(isLocalUrl('http://localhost:8080/v1')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:8080/v1')).toBe(true);
    expect(isLocalUrl('http://[::1]:8080/v1')).toBe(true);
    expect(isLocalUrl('http://0.0.0.0:8000/v1')).toBe(true);
    expect(isLocalUrl('  http://localhost:1234/v1  ')).toBe(true);
  });

  it('远程地址不算本地', () => {
    expect(isLocalUrl('https://api.openai.com/v1')).toBe(false);
    expect(isLocalUrl('https://api.deepseek.com/v1')).toBe(false);
    expect(isLocalUrl('')).toBe(false);
  });

  /**
   * 「没填 Key」的拦截靠这个判断放行本地服务，把别人的域名认成本地
   * 就会让真正缺 Key 的请求发出去，白等一轮 401。
   */
  it('域名里含 localhost 字样的远程地址不算本地', () => {
    expect(isLocalUrl('https://localhost.evil.com/v1')).toBe(false);
    expect(isLocalUrl('https://mylocalhost.com/v1')).toBe(false);
    expect(isLocalUrl('https://api.com/localhost')).toBe(false);
  });
});

describe('usesLoopbackIp', () => {
  /** https 页面访问 http://127.0.0.1 会被混合内容策略拦掉，localhost 则放行 */
  it('区分回环 IP 和 localhost', () => {
    expect(usesLoopbackIp('http://127.0.0.1:8080/v1')).toBe(true);
    expect(usesLoopbackIp('http://[::1]:8080/v1')).toBe(true);
    expect(usesLoopbackIp('http://0.0.0.0:8000/v1')).toBe(true);
    expect(usesLoopbackIp('http://localhost:8080/v1')).toBe(false);
  });

  it('远程地址不触发', () => {
    expect(usesLoopbackIp('https://api.openai.com/v1')).toBe(false);
    expect(usesLoopbackIp('')).toBe(false);
  });
});
