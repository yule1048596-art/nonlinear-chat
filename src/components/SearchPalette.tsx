import { useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useStore } from '../store/useStore';
import type { ChatNode, NodeRole } from '../types';

const ROLE_LABEL: Record<NodeRole, string> = {
  system: '系统',
  user: '你',
  assistant: 'AI',
  note: '批注',
};

const MAX_RESULTS = 40;

interface Hit {
  node: ChatNode;
  /** 命中位置左右各留一点，让用户看清上下文 */
  excerpt: string;
  matchStart: number;
  matchLength: number;
}

function findHits(nodes: Record<string, ChatNode>, query: string): Hit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: Hit[] = [];
  for (const node of Object.values(nodes)) {
    const index = node.content.toLowerCase().indexOf(q);
    if (index === -1) continue;

    const from = Math.max(0, index - 24);
    const to = Math.min(node.content.length, index + q.length + 56);
    const excerpt =
      (from > 0 ? '…' : '') +
      node.content.slice(from, to).replace(/\s+/g, ' ') +
      (to < node.content.length ? '…' : '');

    hits.push({
      node,
      excerpt,
      matchStart: index - from + (from > 0 ? 1 : 0),
      matchLength: q.length,
    });
  }
  // 越晚改动的越可能是用户在找的
  return hits.sort((a, b) => b.node.updatedAt - a.node.updatedAt).slice(0, MAX_RESULTS);
}

export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nodes = useStore((s) => s.graph?.nodes);
  const select = useStore((s) => s.select);
  const { setCenter } = useReactFlow();

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const hits = useMemo(() => (nodes ? findHits(nodes, query) : []), [nodes, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      // 等 DOM 挂上再聚焦
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setCursor(0), [query]);

  // 键盘选中的项要一直可见
  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  const jumpTo = (hit: Hit) => {
    select(hit.node.id);
    // 节点宽 380，往右偏半个宽度才能让它落在视野中间
    setCenter(hit.node.position.x + 190, hit.node.position.y + 100, {
      zoom: 1,
      duration: 320,
    });
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[cursor];
      if (hit) jumpTo(hit);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="palette" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="搜索当前画布的节点内容…"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query.trim() && (
          <div className="palette-count">
            {hits.length ? `${hits.length} 个结果` : '没有匹配的节点'}
          </div>
        )}
        <ul className="palette-list" ref={listRef}>
          {hits.map((hit, i) => (
            <li
              key={hit.node.id}
              className={i === cursor ? 'active' : ''}
              onMouseEnter={() => setCursor(i)}
              onClick={() => jumpTo(hit)}
            >
              <span className={`palette-role role-${hit.node.role}`}>
                {ROLE_LABEL[hit.node.role]}
              </span>
              <span className="palette-excerpt">
                {hit.excerpt.slice(0, hit.matchStart)}
                <mark>{hit.excerpt.slice(hit.matchStart, hit.matchStart + hit.matchLength)}</mark>
                {hit.excerpt.slice(hit.matchStart + hit.matchLength)}
              </span>
            </li>
          ))}
        </ul>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>Enter</kbd> 跳转
          </span>
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
        </div>
      </div>
    </>
  );
}
