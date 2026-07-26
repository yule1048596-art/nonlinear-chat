import type { ChatNode, NodeRole } from '../types';
import { excludeReason, EXCLUDE_LABEL, topoOrder, type NodeMap } from './context';

const HEADING: Record<NodeRole, string> = {
  system: '系统提示',
  user: '你',
  assistant: 'AI',
  note: '批注',
};

export interface PathMarkdownOptions {
  title?: string;
  /** 全局 System 提示词，有就写在最前面 */
  systemPrompt?: string;
  /** 导出时间，测试时传固定值 */
  now?: Date;
}

/**
 * 把「根到某节点」的这条路径导成可读的 Markdown 对话记录。
 *
 * 导出的是整条路径而不是「实际发出去的内容」—— 这份文件是给人读的思考记录，
 * 被静音或出错的节点也是过程的一部分，删掉反而看不懂中间为什么拐弯。
 * 那些节点会标注出来，说明它没有进入模型的上下文。
 */
export function pathToMarkdown(
  nodes: NodeMap,
  targetId: string,
  options: PathMarkdownOptions = {},
): string {
  const chain = topoOrder(nodes, targetId).filter((n) => n.content.trim());
  const when = (options.now ?? new Date()).toLocaleString('zh-CN');

  const out: string[] = [];
  out.push(`# ${options.title?.trim() || '未命名画布'}`);
  out.push('');
  out.push(`> 从 Nexus 画布导出的一条对话路径 · ${when}`);
  out.push('');

  const globalPrompt = options.systemPrompt?.trim();
  if (globalPrompt) {
    out.push('## 全局 System 提示词');
    out.push('');
    out.push(globalPrompt);
    out.push('');
  }

  for (const node of chain) {
    out.push(`## ${heading(node)}`);
    out.push('');
    const reason = excludeReason(node);
    if (reason) {
      out.push(`> 这一条没有进入模型的上下文：${EXCLUDE_LABEL[reason]}`);
      out.push('');
    }
    out.push(node.content.trim());
    out.push('');
  }

  // 结尾多出来的空行去掉，但保留一个换行符收尾
  return `${out.join('\n').trimEnd()}\n`;
}

function heading(node: ChatNode): string {
  const base = HEADING[node.role];
  // 标出是哪个模型答的 —— 并排比较不同模型时，这是最要紧的一条信息
  return node.role === 'assistant' && node.model ? `${base} · ${node.model}` : base;
}

/**
 * 找出和某个节点「同源」的兄弟节点：父节点集合完全一致、且都是回答。
 *
 * 这正是「并排重生」产生的东西 —— 同一个问题的多个版本。要比较的几乎总是
 * 它们，所以不必为此做通用的多选。返回值含自身，按创建时间排序。
 */
export function findSiblings(nodes: NodeMap, id: string): ChatNode[] {
  const target = nodes[id];
  if (!target || target.role !== 'assistant') return [];

  const key = [...target.parentIds].sort().join('|');
  return Object.values(nodes)
    .filter((n) => n.role === 'assistant' && [...n.parentIds].sort().join('|') === key)
    .sort((a, b) => a.createdAt - b.createdAt);
}
