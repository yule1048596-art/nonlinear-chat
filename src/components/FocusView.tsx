import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import {
  buildDeck,
  buildMiniGraph,
  nextChoices,
  previousId,
  type FocusCard,
  type MiniGraph,
} from '../lib/focus';
import { modelLabel, summarize } from '../lib/view';
import { estimateTokens, formatTokens } from '../lib/tokens';
import { isInContext } from '../lib/context';
import { Markdown } from './Markdown';
import { NodeAttachments } from './NodeAttachments';
import type { NodeRole } from '../types';

const ROLE_LABEL: Record<NodeRole, string> = {
  system: '系统',
  user: '你',
  assistant: 'AI',
  note: '批注',
};

/** 后面最多留几张。再多就是一堆看不清的边，还白白渲染内容 */
const STACK_DEPTH = 2;

/**
 * 聚焦视图：一次只摊开一轮对话。
 *
 * 牌堆是「从根到当前节点」那条链 —— 也就是真正发给模型的上下文，
 * 读到的顺序和模型看到的顺序因此永远一致。
 *
 * 但牌堆本身是线性的，光有它这个视图就不知道自己身处一张图里。
 * 分支结构全靠右边那张迷你结构图来交代。
 */
export function FocusView() {
  const nodes = useStore((s) => s.graph?.nodes);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const send = useStore((s) => s.send);
  const addChild = useStore((s) => s.addChild);
  const updateNode = useStore((s) => s.updateNode);

  const [draft, setDraft] = useState('');

  const deck = useMemo(() => buildDeck(nodes ?? {}, selectedId), [nodes, selectedId]);
  const current = deck.cards[deck.index];
  const choices = useMemo(() => nextChoices(nodes ?? {}, current), [nodes, current]);
  const prev = previousId(deck);
  const mini = useMemo(() => buildMiniGraph(nodes ?? {}, selectedId), [nodes, selectedId]);

  useEffect(() => setDraft(''), [current?.id]);

  /*
   * 没有选中节点就自动落到最近动过的那个。否则切进来看到的是一句
   * 「去别的视图选一个再回来」—— 那不算一个视图，算一道门槛。
   */
  useEffect(() => {
    if (selectedId && nodes?.[selectedId]) return;
    const latest = Object.values(nodes ?? {}).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) select(latest.id);
  }, [selectedId, nodes, select]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowUp' && prev) select(prev);
      if (e.key === 'ArrowDown' && choices.length === 1) select(choices[0]!.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, choices, select]);

  if (!nodes) return null;

  const ask = () => {
    const text = draft.trim();
    if (!text || !current) return;
    const anchor = current.nodeIds[current.nodeIds.length - 1]!;
    const id = addChild(anchor, 'user');
    if (!id) return;
    updateNode(id, { content: text });
    setDraft('');
    void send(id);
  };

  /*
   * 关键：卡片按「离当前第几张」定位，而不是每次翻页把前卡卸载重挂。
   * 上一版就是挂了 key={current.id}，翻一页整张卡重建、重放一遍入场动画 ——
   * 那不是牌堆在动，是新卡凭空闪出来，看着当然生硬。
   * 现在每张卡的 key 是它自己的 id，翻页只是 --offset 变了，
   * 剩下的交给 transition，卡片是真的往后退。
   */
  const visible = deck.cards
    .map((card, i) => ({ card, offset: deck.index - i }))
    .filter(({ offset }) => offset >= 0 && offset <= STACK_DEPTH);

  return (
    <div className="focus">
      <div className="focus-stage">
        {visible.map(({ card, offset }) => (
          <Card key={card.id} card={card} offset={offset} />
        ))}
        {!current && (
          <div className="focus-empty">
            <h2>这个画布还没有内容</h2>
            <p>切到「编辑」视图写下第一个问题。</p>
          </div>
        )}
      </div>

      <MiniMap graph={mini} onPick={select} />

      <div className="focus-bar">
        <button className="btn quiet" disabled={!prev} onClick={() => prev && select(prev)} title="上一轮　↑">
          ↑ 上一轮
        </button>

        <div className="focus-input">
          <textarea
            rows={1}
            value={draft}
            placeholder="接着问……（⌘/Ctrl + Enter 发送）"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                ask();
              }
            }}
          />
          <button className="btn primary" disabled={!draft.trim()} onClick={ask}>
            发送
          </button>
        </div>

        {choices.length <= 1 ? (
          <button
            className="btn quiet"
            disabled={choices.length === 0}
            onClick={() => choices[0] && select(choices[0].id)}
            title="下一轮　↓"
          >
            下一轮 ↓
          </button>
        ) : (
          <div className="focus-branches">
            <span className="focus-hint">{choices.length} 条分支</span>
            {choices.map((n, i) => (
              <button
                key={n.id}
                className="btn quiet"
                title={summarize(n.content, 30) || `分支 ${i + 1}`}
                onClick={() => select(n.id)}
              >
                {i + 1}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 一张卡：标题 + 右对齐的提问 + 正文回答。offset 决定它在牌堆里的第几层 */
function Card({ card, offset }: { card: FocusCard; offset: number }) {
  const nodes = useStore((s) => s.graph?.nodes);
  const question = card.questionId ? nodes?.[card.questionId] : undefined;
  const answer = card.answerId ? nodes?.[card.answerId] : undefined;
  const lone = !question && !answer ? nodes?.[card.id] : undefined;
  const head = question ?? lone;
  if (!head && !answer) return null;

  const title = summarize(head?.content ?? answer?.content ?? '', 24) || '（空）';
  const tokens =
    estimateTokens(question?.content ?? '') +
    estimateTokens(answer?.content ?? '') +
    estimateTokens(lone?.content ?? '');
  const muted = [question, answer, lone].some((n) => n && !isInContext(n));

  const classes = ['focus-card', offset > 0 ? 'is-behind' : '', muted ? 'is-muted' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <article
      className={classes}
      style={{ '--offset': offset } as React.CSSProperties}
      aria-hidden={offset > 0}
    >
      <header className="focus-card-head">
        <h2>{title}</h2>
        <span className="spacer" />
        {answer?.model && <span className="focus-model">{modelLabel(answer.model)}</span>}
        {tokens > 0 && <span className="focus-tokens">≈{formatTokens(tokens)}</span>}
      </header>

      <div className="focus-card-body">
        {question && (
          <div className="focus-ask">
            <div className="focus-bubble">{question.content || '（空提问）'}</div>
            <NodeAttachments nodeId={question.id} />
          </div>
        )}

        {lone && (
          <div className={`focus-lone node-${lone.role}`}>
            <span className="focus-role">{ROLE_LABEL[lone.role]}</span>
            <Markdown>{lone.content || '（空）'}</Markdown>
          </div>
        )}

        {answer && (
          <div className="focus-answer">
            {answer.content ? (
              <Markdown>{answer.content}</Markdown>
            ) : (
              <p className="focus-hint">
                {answer.status === 'streaming' ? '正在生成…' : '还没有回答'}
              </p>
            )}
            {answer.error && <div className="node-error">{answer.error}</div>}
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * 右侧的迷你结构图。
 *
 * 上一版这里是一列直上直下的圆点，只画当前路径 —— 那等于把这个应用
 * 最要紧的东西（它是一张图，不是一条线）从视图里删掉了。
 * 现在画的是「当前这条链 + 挂在它上面的每一处分叉 + 它通向哪儿」，
 * 亮的是当前路径，暗的是岔出去的别的可能，点哪个跳哪个。
 */
function MiniMap({ graph, onPick }: { graph: MiniGraph; onPick: (id: string) => void }) {
  const nodes = useStore((s) => s.graph?.nodes);
  const ref = useRef<SVGSVGElement>(null);

  if (graph.nodes.length <= 1) return null;

  const pad = 10;
  const w = graph.width + pad * 2;
  const h = graph.height + pad * 2;

  /*
   * 必须给出实际宽高。只有 viewBox 的话 SVG 在 flex 容器里会塌成 0×0 ——
   * 元素在、圆点也在，就是一个像素都画不出来。
   *
   * 这里给的是「固有尺寸」，真正的上限交给 CSS 的 vh/px ——
   * 用 JS 读 window.innerHeight 既不响应窗口缩放，
   * 在还没布局的时候还会读到 0，把整张图缩成零。
   */
  const scale = 2;

  return (
    <div className="focus-minimap">
      <svg
        ref={ref}
        viewBox={`0 0 ${w} ${h}`}
        width={w * scale}
        height={h * scale}
        role="group"
        aria-label="这条链周围的分支结构"
      >
        {graph.edges.map((e) => {
          // 竖直方向的贝塞尔，和画布上的连线是同一种语言
          const midY = (e.y1 + e.y2) / 2;
          return (
            <path
              key={e.id}
              className={e.onPath ? 'mini-edge on-path' : 'mini-edge'}
              d={`M ${e.x1 + pad} ${e.y1 + pad} C ${e.x1 + pad} ${midY + pad}, ${e.x2 + pad} ${midY + pad}, ${e.x2 + pad} ${e.y2 + pad}`}
            />
          );
        })}
        {graph.nodes.map((n) => (
          <circle
            key={n.id}
            className={[
              'mini-node',
              `mm-${n.role}`,
              n.onPath ? 'on-path' : '',
              n.current ? 'is-current' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            cx={n.x + pad}
            cy={n.y + pad}
            r={n.current ? 5.5 : 3.4}
            onClick={() => onPick(n.id)}
          >
            <title>{summarize(nodes?.[n.id]?.content ?? '', 30) || ROLE_LABEL[n.role]}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
