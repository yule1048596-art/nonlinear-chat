import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { buildDeck, nextChoices, previousId, type FocusCard } from '../lib/focus';
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

/** 后面最多露出几张。再多就是一堆看不清的边，纯占地方 */
const STACK_DEPTH = 3;

/**
 * 聚焦视图：一次只看一轮对话。
 *
 * 和另外两个视图的分工：编辑视图改结构、地图视图看全局、这里专心读。
 * 一摞卡片就是「从根到当前节点」那条链 —— 也就是真正发给模型的上下文，
 * 所以读到的顺序和模型看到的顺序永远一致。
 */
export function FocusView() {
  const nodes = useStore((s) => s.graph?.nodes);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const send = useStore((s) => s.send);
  const addChild = useStore((s) => s.addChild);
  const updateNode = useStore((s) => s.updateNode);

  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const deck = useMemo(() => buildDeck(nodes ?? {}, selectedId), [nodes, selectedId]);
  const current = deck.cards[deck.index];
  const choices = useMemo(() => nextChoices(nodes ?? {}, current), [nodes, current]);
  const prev = previousId(deck);

  // 翻到新的一张时把草稿清掉 —— 那句话是写给上一轮的
  useEffect(() => setDraft(''), [current?.id]);

  /*
   * 没有选中节点就自动落到最近动过的那个。
   * 否则切进这个视图看到的是一句「去别的视图选一个再回来」，
   * 等于把人原路赶回去 —— 那不算一个视图，算一道门槛。
   */
  useEffect(() => {
    if (selectedId && nodes?.[selectedId]) return;
    const latest = Object.values(nodes ?? {}).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) select(latest.id);
  }, [selectedId, nodes, select]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 在输入框里打字时别抢方向键
      if ((e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowUp' && prev) select(prev);
      if (e.key === 'ArrowDown' && choices.length === 1) select(choices[0]!.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, choices, select]);

  if (!nodes) return null;

  if (!current) {
    return (
      <div className="focus">
        <div className="focus-empty">
          <h2>选一个节点开始读</h2>
          <p>聚焦视图一次只展开一轮对话，更早的几轮叠在它后面。</p>
          <p>切到「编辑」视图点任意一个节点，再回来。</p>
        </div>
      </div>
    );
  }

  const ask = () => {
    const text = draft.trim();
    if (!text) return;
    // 追问接在这张卡的最后一个节点下面
    const anchor = current.nodeIds[current.nodeIds.length - 1]!;
    const id = addChild(anchor, 'user');
    if (!id) return;
    updateNode(id, { content: text });
    setDraft('');
    void send(id);
  };

  return (
    <div className="focus">
      <div className="focus-stage">
        {/* 后面几张只露边角，给「这是一摞」的实感 */}
        {deck.cards.slice(Math.max(0, deck.index - STACK_DEPTH), deck.index).map((card, i, arr) => (
          <div
            key={card.id}
            className="focus-card is-behind"
            style={{ '--depth': arr.length - i } as React.CSSProperties}
            aria-hidden
          />
        ))}
        <Card key={current.id} card={current} />
      </div>

      <Navigator deck={deck} onPick={select} />

      <div className="focus-bar">
        {prev ? (
          <button className="btn quiet" onClick={() => select(prev)} title="上一轮　↑">
            ↑ 上一轮
          </button>
        ) : (
          <span className="focus-hint">最早的一轮</span>
        )}

        <div className="focus-input">
          <textarea
            ref={inputRef}
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

        {choices.length === 0 && <span className="focus-hint">没有下一轮</span>}
        {choices.length === 1 && (
          <button className="btn quiet" onClick={() => select(choices[0]!.id)} title="下一轮　↓">
            下一轮 ↓
          </button>
        )}
        {choices.length > 1 && (
          <div className="focus-branches" title="这里有岔路，选一条">
            <span className="focus-hint">{choices.length} 条分支</span>
            {choices.map((n, i) => (
              <button key={n.id} className="btn quiet" onClick={() => select(n.id)}>
                {i + 1}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 一张卡：标题 + 右对齐的提问 + 正文回答 */
function Card({ card }: { card: FocusCard }) {
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

  return (
    <article className={muted ? 'focus-card is-muted' : 'focus-card'}>
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
 * 右侧的导航器。
 *
 * 刻意做成一列小圆点而不是缩略卡片 —— 它要回答的只有一个问题：
 * 「这条链有多长、我在第几个」。放文字反而看不清。
 */
function Navigator({ deck, onPick }: { deck: ReturnType<typeof buildDeck>; onPick: (id: string) => void }) {
  const nodes = useStore((s) => s.graph?.nodes);
  if (deck.cards.length <= 1) return null;

  return (
    <nav className="focus-nav" aria-label="这条链上的各轮">
      {deck.cards.map((card, i) => {
        const head = nodes?.[card.questionId ?? card.id];
        const label = summarize(head?.content ?? '', 18) || `第 ${i + 1} 轮`;
        return (
          <button
            key={card.id}
            className={i === deck.index ? 'focus-dot is-current' : 'focus-dot'}
            title={label}
            aria-current={i === deck.index}
            onClick={() => onPick(card.nodeIds[card.nodeIds.length - 1]!)}
          />
        );
      })}
    </nav>
  );
}
