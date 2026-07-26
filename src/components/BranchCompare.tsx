import { useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useStore } from '../store/useStore';
import { findSiblings } from '../lib/markdown';
import { isInContext } from '../lib/context';
import { estimateTokens, formatTokens } from '../lib/tokens';
import { Markdown } from './Markdown';

export function BranchCompare({
  nodeId,
  onClose,
}: {
  nodeId: string | null;
  onClose: () => void;
}) {
  const nodes = useStore((s) => s.graph?.nodes);
  const select = useStore((s) => s.select);
  const updateNode = useStore((s) => s.updateNode);
  const { setCenter } = useReactFlow();

  const siblings = useMemo(
    () => (nodes && nodeId ? findSiblings(nodes, nodeId) : []),
    [nodes, nodeId],
  );

  if (!nodeId || siblings.length === 0) return null;

  const jumpTo = (id: string) => {
    const node = nodes?.[id];
    if (!node) return;
    select(id);
    setCenter(node.position.x + 190, node.position.y + 100, { zoom: 1, duration: 320 });
    onClose();
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="compare">
        <header className="compare-head">
          <h2>同一个问题的 {siblings.length} 个回答</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="compare-columns">
          {siblings.map((node, i) => {
            const active = isInContext(node);
            return (
              <section
                key={node.id}
                className={node.id === nodeId ? 'compare-col current' : 'compare-col'}
              >
                <header className="compare-col-head">
                  <span className="compare-index">第 {i + 1} 版</span>
                  {node.model && <span className="node-model">{node.model}</span>}
                  {!active && <span className="context-badge off">已静音</span>}
                </header>

                <div className="compare-meta">
                  <span>≈{formatTokens(estimateTokens(node.content))} tokens</span>
                  {node.usage?.completion != null && (
                    <span className="mono">
                      {node.usage.prompt ?? '?'}→{node.usage.completion}
                    </span>
                  )}
                  <span>{new Date(node.createdAt).toLocaleTimeString('zh-CN')}</span>
                </div>

                <div className="compare-content nowheel">
                  {node.content ? (
                    <Markdown>{node.content}</Markdown>
                  ) : (
                    <div className="node-placeholder">还没有内容</div>
                  )}
                </div>

                <footer className="compare-col-foot">
                  <button className="btn" onClick={() => jumpTo(node.id)}>
                    跳到画布
                  </button>
                  <span className="spacer" />
                  <button
                    className="btn"
                    title={
                      active
                        ? '静音这一版：留在画布上，但下游不会带上它'
                        : '取消静音，让它重新进入下游上下文'
                    }
                    onClick={() =>
                      updateNode(node.id, { contextMode: active ? 'exclude' : 'include' })
                    }
                  >
                    {active ? '静音这版' : '取消静音'}
                  </button>
                </footer>
              </section>
            );
          })}
        </div>

        <div className="compare-foot">
          几个回答挂在同一批父节点下。留着都不删也行 —— 把不想要的静音掉，
          下游就只会带上你选中的那一版。
        </div>
      </div>
    </>
  );
}
