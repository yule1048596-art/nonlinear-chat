/**
 * 模块级 toast。
 *
 * 为什么不用 props/context：节点组件由 React Flow 渲染，想传函数只能塞进
 * node.data，而那会破坏 Canvas 里按 id 缓存节点对象的优化（data 一变就得
 * 换新对象）。做成订阅之后，任何模块 import 一下就能弹提示。
 */

type Listener = (message: string) => void;

const listeners = new Set<Listener>();

export function toast(message: string): void {
  for (const listener of listeners) listener(message);
}

export function subscribeToast(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
