import { useEffect, useMemo, useState } from 'react';
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
import { AutoTextarea } from './AutoTextarea';
import { Markdown } from './Markdown';
import { AttachButton, NodeAttachments } from './NodeAttachments';
import { findSiblings } from '../lib/markdown';
import { placeChild } from '../lib/layout';
import { toast } from '../lib/toast';
import type { ChatNode, NodeRole } from '../types';

const ROLE_LABEL: Record<NodeRole, string> = {
  system: '系统',
  user: '你',
  assistant: 'AI',
  note: '批注',
};

/** 后面最多留几张。三张刚好摊得开一把扇形，再多就是一堆看不清的边 */
const STACK_DEPTH = 3;

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
  /*
   * 附件必须挂在一个真实节点上，可「还没发出去的下一问」并不存在。
   * 所以点「附件」时就地建出这个节点，输入框随后就绑定到它 ——
   * 这正是原来「追问」按钮在做的事，现在收进输入框里，不再单列一个按钮。
   */
  const [draftNodeId, setDraftNodeId] = useState<string | null>(null);
  /*
   * 下一问挂在哪：`tail` 接在这一轮的回答后面，`head` 挂回这一轮的提问上
   * ——后者就是原来的「分支」。
   *
   * 做成一直摆在那里的两选一，而不是「发送」旁边多一个按钮：那个按钮
   * 只在输入框有字时才可用，空框时被 opacity 压到 0.4，看着就是没有。
   * 落点是**发送之前要先决定**的事，不该长得像第二个提交键。
   */
  const [anchor, setAnchor] = useState<'tail' | 'head'>('tail');

  const deck = useMemo(() => buildDeck(nodes ?? {}, selectedId), [nodes, selectedId]);
  const current = deck.cards[deck.index];
  const choices = useMemo(() => nextChoices(nodes ?? {}, current), [nodes, current]);
  const prev = previousId(deck);
  const mini = useMemo(() => buildMiniGraph(nodes ?? {}, selectedId), [nodes, selectedId]);

  // 换卡时清掉草稿。草稿节点不删 —— 上面可能已经挂了附件，删了文件就没了
  useEffect(() => {
    setDraft('');
    setDraftNodeId(null);
    setAnchor('tail'); // 落点是相对这张卡说的，换卡就得回到默认
  }, [current?.id]);

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

  /** 这张卡的两个落点：接着问挂在末节点上，另起分支挂在提问上 */
  const tailId = current?.nodeIds[current.nodeIds.length - 1];
  const headId = current?.questionId ?? current?.nodeIds[0];
  // 单节点卡（还没有回答的提问、独立的回答、批注）两个落点本来就是同一个
  const canFork = !!headId && !!tailId && headId !== tailId;
  const anchorId = anchor === 'head' && canFork ? headId : tailId;

  /**
   * 就地建出草稿节点，「附件」要挂到它上面。
   *
   * 两处都是为了不把人从当前这张卡上带走：
   *
   * 1. `addChild` 会把选中项挪到新节点上，牌堆跟着翻页 —— 可这只是个
   *    占位的空草稿，翻过去看到的就是一张空卡。建完立刻把选中项还回去。
   * 2. **一律挂在末节点上**，哪怕这会儿选的是「另起分支」。挂在提问上
   *    会让提问多出一个子节点，一问一答就不再合并，这张卡当场裂成两张，
   *    `current.id` 一变，上面那个 effect 就把草稿绑定清空了 ——
   *    附件挂上去了，输入框却不认它。真正的落点在发送时才定。
   */
  const ensureDraftNode = () => {
    if (draftNodeId) return draftNodeId;
    if (!tailId) return null;
    const keep = selectedId;
    const id = addChild(tailId, 'user');
    if (keep) select(keep);
    if (id) setDraftNodeId(id);
    return id;
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || !anchorId) return;
    // 已经为附件建过草稿节点就复用它，否则现建一个
    const id = draftNodeId ?? addChild(anchorId, 'user');
    if (!id) return;
    const patch: Partial<ChatNode> = { content: text };
    // 草稿是挂在末节点上建的，这里才把它改挂到真正选的落点
    const parent = nodes[anchorId];
    if (parent && nodes[id] && nodes[id].parentIds[0] !== anchorId) {
      // 排位置时要把草稿自己排除掉，否则它占着的那格会被当成「有人了」
      const others = { ...nodes };
      delete others[id];
      patch.parentIds = [anchorId];
      patch.position = placeChild(others, [parent]);
    }
    updateNode(id, patch);
    setDraft('');
    setDraftNodeId(null);
    void send(id);
  };

  /*
   * 关键：卡片按「离当前第几张」定位，而不是每次翻页把前卡卸载重挂。
   * 上一版就是挂了 key={current.id}，翻一页整张卡重建、重放一遍入场动画 ——
   * 那不是牌堆在动，是新卡凭空闪出来，看着当然生硬。
   * 现在每张卡的 key 是它自己的 id，翻页只是 --offset 变了，
   * 剩下的交给 transition，卡片是真的往后退。
   */
  /*
   * 前方那一张（offset -1）也要渲染出来。
   *
   * 少了它，往回翻时当前这张只能从 DOM 里消失 —— 最该有过渡的那张
   * （正在进/出最前面的那张）反而是硬切，后面几张滑得再顺也没用。
   * 有了它，翻页才是一张滑出去、下一张滑上来。
   */
  const visible = [
    ...deck.cards
      .map((card, i) => ({ card, offset: deck.index - i }))
      .filter(({ offset }) => offset >= 0 && offset <= STACK_DEPTH),
    ...deck.ahead.map((card, k) => ({ card, offset: -(k + 1) })),
  ];

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

        <div className="focus-compose">
          {/*
            * 落点选择器。一直摆在这儿，不随输入框空不空变样 ——
            * 「分支」是这个视图里唯一能开出新路的动作，它不能时隐时现。
            */}
          <div className="focus-anchor" role="group" aria-label="下一问挂在哪">
            <button
              className={anchor === 'tail' || !canFork ? 'is-on' : ''}
              onClick={() => setAnchor('tail')}
              title="挂在这一轮的回答后面，顺着往下走"
            >
              接着问
            </button>
            <button
              className={anchor === 'head' && canFork ? 'is-on' : ''}
              disabled={!canFork}
              onClick={() => setAnchor('head')}
              title={
                canFork
                  ? '挂回这一轮的提问上，从同一个问题另开一条路（原来的「分支」）'
                  : '这一轮还只有一个节点，两个落点是同一个，等有了回答再分'
              }
            >
              另起分支
            </button>
            {draftNodeId && <span className="focus-hint">已建好草稿节点，附件挂在它上面</span>}
          </div>
          {draftNodeId && <NodeAttachments nodeId={draftNodeId} />}
          <div className="focus-input">
            <AttachButton nodeId={draftNodeId} onNeedNode={ensureDraftNode} />
            <textarea
              rows={1}
              value={draft}
              placeholder={
                anchor === 'head' && canFork
                  ? '从这一轮的提问另开一条……（⌘/Ctrl + Enter 发送）'
                  : '接着问……（⌘/Ctrl + Enter 发送）'
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <button className="btn primary" disabled={!draft.trim()} onClick={submit}>
              发送
            </button>
          </div>
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

/**
 * 一张卡在牌堆里的位置。
 *
 * 变换在这里算好写成内联样式，**不走 CSS 里的 calc(var(--offset))** ——
 * 那条路不可靠：自定义属性没注册过，它变化时浏览器不会正常重跑 transform 的
 * 过渡，实测值会整体滞后一拍（前卡顶着后一张的变换和透明度）。
 * 内联字符串每次都是新的指定值，过渡必然触发。
 *
 * 斜堆叠：平移 + 旋转 + 微缩。光靠平移是「正着摞」，得偏很多才露得出来；
 * 转一点角度之后，同样大小的卡片两个对角自然探出前卡，位移就能给得很小。
 */
function stackStyle(offset: number): React.CSSProperties {
  // 还没轮到的那张停在「更靠前、更大一点」的位置等着，给翻页一个落点
  if (offset < 0) {
    return { transform: 'translateY(30px) scale(1.035)', opacity: 0, zIndex: 11 };
  }
  return {
    transform: `translate(${offset * 9}px, ${offset * -12}px) rotate(${offset * -1.9}deg) scale(${(1 - offset * 0.022).toFixed(4)})`,
    opacity: Math.max(0, 1 - offset * 0.24),
    zIndex: 10 - offset,
  };
}

/**
 * 一个节点的操作条。
 *
 * 聚焦视图一开始是只读的 —— 那是个设计失误：它恰恰是唯一把一整轮对话
 * 完整摊开的地方，最该能直接动手。为了改一句话要切回编辑视图，
 * 正是这个视图想省掉的那道来回。
 *
 * 动作和编辑视图完全一致（同一批 store action），只是按「提问 / 回答」
 * 分成两条，各自贴着它作用的那半张卡 —— 否则一排按钮堆在卡底，
 * 看不出「重生」重生的是谁。
 */
function CardActions({ node }: { node: ChatNode }) {
  const updateNode = useStore((s) => s.updateNode);
  const removeNode = useStore((s) => s.removeNode);
  const regenerate = useStore((s) => s.regenerate);
  const branchRegenerate = useStore((s) => s.branchRegenerate);
  const setCompare = useStore((s) => s.setCompare);
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  // 聚焦视图一次只显示一张卡，这里调一次不像画布上那样是 O(N²)
  const siblingCount = useStore((s) => (s.graph ? findSiblings(s.graph.nodes, node.id).length : 0));
  const [copied, setCopied] = useState(false);

  const streaming = node.status === 'streaming';
  const inContext = isInContext(node);

  const copy = () => {
    void navigator.clipboard.writeText(node.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="focus-actions">
      {node.role === 'assistant' ? (
        streaming ? (
          <button className="btn solid" onClick={() => stop(node.id)}>
            停止
          </button>
        ) : (
          <>
            {/*
              * 这里原本还有「追问」。它和底部输入框、以及提问那条上的「分支」
              * 是同一件事的三个变体 —— 都只是在某个节点下面建一个空的提问节点，
              * 差别仅在挂点。三个入口做一件事，一屏两个输入框，只会让人猜。
              * 现在统一收进底部：落点由输入框上方那个两选一决定。
              */}
            <button className="btn" onClick={() => void regenerate(node.id)} title="就地重新生成">
              重生
            </button>
            <button
              className="btn"
              onClick={() => void branchRegenerate(node.id)}
              title="保留这个回答，在旁边并排生成另一个版本"
            >
              并排
            </button>
            {siblingCount > 1 && (
              <button
                className="btn"
                onClick={() => setCompare(node.id)}
                title={`和同一个问题的另外 ${siblingCount - 1} 个回答并排比较`}
              >
                对比 {siblingCount}
              </button>
            )}
          </>
        )
      ) : (
        <>
          {/*
            * 提问节点必须有「发送」。底部那个输入框是给这张卡再接一个子节点的，
            * 填不了这一张 —— 少了它，「追问」建出来的空提问就是一张死卡。
            */}
          {node.role === 'user' && (
            <button
              className="btn primary"
              disabled={!node.content.trim()}
              onClick={() => void send(node.id)}
              title="⌘/Ctrl + Enter"
            >
              发送
            </button>
          )}
          {/* 「分支」也收进底部输入框了，见上面那段说明 */}
          <AttachButton nodeId={node.id} />
        </>
      )}

      <span className="spacer" />

      <button
        className="icon-btn"
        title={
          inContext
            ? '在上下文中 · 点击静音（留着但不发出去）'
            : node.role === 'note'
              ? '批注默认不进上下文 · 点击让它参与'
              : '已静音 · 点击恢复'
        }
        onClick={() => updateNode(node.id, { contextMode: inContext ? 'exclude' : 'include' })}
      >
        {inContext ? '◉' : '◌'}
      </button>
      {node.content && (
        <button className="icon-btn" title="复制内容" onClick={copy}>
          {copied ? '✓' : '⧉'}
        </button>
      )}
      <button
        className="icon-btn danger"
        title="删除（按住 Shift 连同所有下游一起删）"
        onClick={(e) => {
          const count = removeNode(node.id, e.shiftKey);
          toast(count > 1 ? `已删除 ${count} 个节点 · ⌘Z 撤销` : '已删除 · ⌘Z 撤销');
        }}
      >
        ✕
      </button>
    </div>
  );
}

/** 一张卡：标题 + 右对齐的提问 + 正文回答。offset 决定它在牌堆里的第几层 */
function Card({ card, offset }: { card: FocusCard; offset: number }) {
  const nodes = useStore((s) => s.graph?.nodes);
  const updateNode = useStore((s) => s.updateNode);
  const send = useStore((s) => s.send);
  const question = card.questionId ? nodes?.[card.questionId] : undefined;
  const answer = card.answerId ? nodes?.[card.answerId] : undefined;
  const lone = !question && !answer ? nodes?.[card.id] : undefined;
  const head = question ?? lone;
  if (!head && !answer) return null;

  const title = summarize(head?.content ?? answer?.content ?? '', 24) || '新的一轮';
  const tokens =
    estimateTokens(question?.content ?? '') +
    estimateTokens(answer?.content ?? '') +
    estimateTokens(lone?.content ?? '');
  const muted = [question, answer, lone].some((n) => n && !isInContext(n));

  const classes = [
    'focus-card',
    offset > 0 ? 'is-behind' : '',
    offset < 0 ? 'is-ahead' : '',
    muted ? 'is-muted' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={classes} style={stackStyle(offset)} aria-hidden={offset !== 0}>
      <header className="focus-card-head">
        <h2>{title}</h2>
        <span className="spacer" />
        {answer?.model && <span className="focus-model">{modelLabel(answer.model)}</span>}
        {tokens > 0 && <span className="focus-tokens">≈{formatTokens(tokens)}</span>}
      </header>

      <div className="focus-card-body">
        {question && (
          <div className="focus-ask">
            {/*
              * 提问是可以改的，不是一段只读文字。
              * 「追问」建出来的是一个空提问节点，没有输入框就永远填不进内容。
              * 只有最前那张给输入框：后面几张被挡得只剩边角。
              */}
            {offset === 0 ? (
              <AutoTextarea
                className="focus-bubble focus-bubble-input"
                value={question.content}
                placeholder="写下这一轮要问的话……"
                autoFocus={!question.content}
                maxHeight={220}
                onChange={(v) => updateNode(question.id, { content: v })}
                onSubmit={() => void send(question.id)}
              />
            ) : (
              <div className="focus-bubble">{question.content || '（还没写）'}</div>
            )}
            <NodeAttachments nodeId={question.id} />
            {offset === 0 && <CardActions node={question} />}
          </div>
        )}

        {lone && (
          <div className={`focus-lone node-${lone.role}`}>
            <span className="focus-role">{ROLE_LABEL[lone.role]}</span>
            {/* assistant 的正文是模型生成的，不给改；其余都能改 */}
            {offset === 0 && lone.role !== 'assistant' ? (
              <AutoTextarea
                className="focus-lone-input"
                value={lone.content}
                placeholder={lone.role === 'user' ? '写下要问的话……' : '写点什么……'}
                autoFocus={!lone.content}
                maxHeight={260}
                onChange={(v) => updateNode(lone.id, { content: v })}
                onSubmit={lone.role === 'user' ? () => void send(lone.id) : undefined}
              />
            ) : (
              <Markdown>{lone.content || '（还没写）'}</Markdown>
            )}
            {offset === 0 && <CardActions node={lone} />}
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
            {offset === 0 && <CardActions node={answer} />}
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * 右侧的迷你结构图 —— 就是编辑视图那张画布的缩略图。
 *
 * 前两版都在自己排版（先 dagre、后手写直脊），画出来是「另一张图」，
 * 和用户在画布上亲手摆过的那张对不上，怎么调都别扭。现在直接用画布坐标：
 * 你怎么摆的，这儿就怎么显示，有几棵树就是几棵。
 * 唯一的抽象是一问一答缩成一个圆。
 */
function MiniMap({ graph, onPick }: { graph: MiniGraph; onPick: (id: string) => void }) {
  const nodes = useStore((s) => s.graph?.nodes);
  if (graph.nodes.length <= 1) return null;

  /*
   * 坐标直接来自编辑视图，跨度可能有几千像素，先等比缩到导航栏这么大。
   * 用 viewBox 让 SVG 自己缩，圆点半径再按缩放反算回去 ——
   * 否则整张图一缩，圆点会小成看不见的针尖。
   */
  const pad = 14;
  const w = graph.width + pad * 2;
  const h = graph.height + pad * 2;
  const BOX_W = 140;
  const BOX_H = 440;
  const fit = Math.min(BOX_W / w, BOX_H / h);
  // 再小圆圈就糊成实心点了，空心/实心的区别是这张图的主要语义
  const r = 5.4 / fit;

  return (
    <div className="focus-minimap">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width={Math.round(w * fit)}
        height={Math.round(h * fit)}
        role="group"
        aria-label="整张画布的结构"
      >
        {graph.edges.map((e) => {
          /*
           * 竖直方向的贝塞尔：从父节点垂直出发、垂直落到子节点。
           * 直线在这里会拉出一堆斜着穿过图面的长线，交角乱；曲线的两端都是
           * 竖直的，分叉看起来是「从这儿岔出去」而不是「斜拉过去」。
           * 和画布上的连线也是同一种语言。
           */
          const my = (e.y1 + e.y2) / 2 + pad;
          return (
            <path
              key={e.id}
              className={e.onPath ? 'mini-edge on-path' : 'mini-edge'}
              d={`M ${e.x1 + pad} ${e.y1 + pad} C ${e.x1 + pad} ${my}, ${e.x2 + pad} ${my}, ${e.x2 + pad} ${e.y2 + pad}`}
              strokeWidth={(e.onPath ? 2.4 : 1.5) / fit}
              strokeLinecap="round"
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
            r={n.current ? r * 1.6 : r}
            strokeWidth={1.6 / fit}
            onClick={() => onPick(n.id)}
          >
            <title>{summarize(nodes?.[n.id]?.content ?? '', 30) || ROLE_LABEL[n.role]}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
