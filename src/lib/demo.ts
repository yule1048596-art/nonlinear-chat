import type { ChatNode, Graph } from '../types';
import type { NodeMap } from './context';

/**
 * 首次打开时放进去的示例画布。
 *
 * 在这之前，新访客看到的是一张空画布和一个空节点 —— 而这个应用最值钱的
 * 东西（两条分支汇进同一个提问）要发三四轮、再手动拖一条边才看得见，
 * 并且**必须先去申请一个 API Key**。于是最该被看到的那件事，恰好在
 * 漏斗最深处。
 *
 * 所以这张画布是预填好的：不配 Key 也能读、能选中节点看上下文高亮、
 * 能在底部状态条上看见「这一发会带上几条消息」。
 *
 * 里面的回答是**手写的样例文本**，不是任何模型的真实输出，因此不挂
 * 模型名（卡片左上角显示的就是通用的「AI」）。画布里那条批注也把这件事
 * 写明了 —— 演示可以是假的，但不能假装不是。
 */

/** 示例画布的标记。删掉之后不再重新播种，靠它在 kv 里记一笔 */
export const DEMO_SEEDED_KEY = 'demoSeeded';

const SYSTEM = '你是资深后端工程师。回答给权衡和适用条件，不要只给结论。';

const Q1 = '我们要给公开 API 加限流，选哪种算法？';

const A1 = `三种常见做法，差别主要在**对突发流量的态度**：

- **令牌桶** — 桶里按固定速率攒令牌，攒得下就允许突发。适合「平均值要控住、但偶尔冒尖没关系」的公开 API。
- **漏桶** — 出水速率恒定，突发一律排队或丢弃。适合下游是个脆弱的同步依赖、宁可慢也不能被冲垮的场景。
- **滑动窗口计数** — 实现最简单，但窗口边界上会放过接近两倍的量。

公开 API 一般选令牌桶：用户偶尔连发几下是正常行为，漏桶会把这种正常行为也判成违规。`;

const Q2 = '另一件事：缓存雪崩怎么防？';

const A2 = `雪崩是「大量 key 在同一时刻一起失效，请求全部穿透到数据库」。三种手段常一起用：

- **过期时间加随机抖动** — 最便宜，把集中失效摊开成一段区间。只能防「一起过期」，防不住热点 key 单独失效。
- **互斥重建** — 同一个 key 只放一个请求去回源，其余等待。防得住热点，代价是引入了一把分布式锁。
- **逻辑过期** — 数据永不物理过期，只在值里记一个逻辑过期时间，过期后异步刷新、同步返回旧值。永远不阻塞读，代价是有一段时间返回的是旧数据。

对一致性要求不高的读多场景，逻辑过期通常最稳。`;

const Q3 = '把这两块合起来看 —— 限流和缓存该怎么配合？';

const A3 = `合起来看，它们其实在防同一件事的两端，**顺序不能反**：

1. **限流在最外层，缓存在它后面。** 限流先把总量削到系统能扛的水位，缓存再决定这些请求里有多少真的落到数据库。反过来的话，缓存击穿的瞬间限流已经放行了。
2. **缓存重建要单独限流。** 互斥重建那把锁本质上就是「回源并发 = 1」的限流器，只是粒度到了单个 key。
3. **两者的失败模式要对齐。** 限流拒绝时返回 429 让客户端退避；缓存回源失败时返回旧值而不是穿透 —— 都是「宁可给次一等的答案，也不要把压力传下去」。

最容易出事的是漏了第 2 条：外层限流看着好好的，某个热点 key 一失效，被放行的那批请求全部涌向数据库。`;

/*
 * 批注是纯文本框（只有 AI 节点才渲染 Markdown），所以这里一个星号都不能用 ——
 * 写了就原样显示成 `**这样**`。
 */
const NOTE = `这是一张示例画布，演示「多父合并」—— 和线性聊天最大的区别。

右边两条分支各自独立展开，互不干扰。最下面那个提问同时挂着两条分支的回答，于是模型一次看到完整的五条消息，不用你把前面的内容复制粘贴一遍。

试试看：点最下面那个提问。不在它上下文里的节点会褪灰，底部状态条会报出这一发带几条消息、约多少 token —— 点它还能逐条看到实际发出去的内容。

里面的回答是手写的样例文字，不是模型输出，所以没有模型名。看够了删掉这张画布即可，不会再出现。`;

interface Seed {
  key: string;
  role: ChatNode['role'];
  content: string;
  parents: string[];
  x: number;
  y: number;
}

/*
 * 排版直接写死。
 *
 * 这张图的形状本身就是它要讲的话 —— 左右两条分支、底下汇成一个点。
 * 交给 dagre 自动排一遍未必还是这个样子，而第一眼看到的东西不该看运气。
 */
const SEEDS: Seed[] = [
  // 批注放在最上面偏左：视线从左上角开始，它该是第一句话
  { key: 'note', role: 'note', content: NOTE, parents: [], x: -60, y: -380 },
  { key: 'sys', role: 'system', content: SYSTEM, parents: [], x: 400, y: -160 },
  { key: 'q1', role: 'user', content: Q1, parents: ['sys'], x: 0, y: 0 },
  { key: 'a1', role: 'assistant', content: A1, parents: ['q1'], x: 0, y: 150 },
  { key: 'q2', role: 'user', content: Q2, parents: ['sys'], x: 800, y: 0 },
  { key: 'a2', role: 'assistant', content: A2, parents: ['q2'], x: 800, y: 150 },
  { key: 'q3', role: 'user', content: Q3, parents: ['a1', 'a2'], x: 400, y: 530 },
  { key: 'a3', role: 'assistant', content: A3, parents: ['q3'], x: 400, y: 680 },
];

/**
 * 造出示例画布。
 *
 * id 由调用方给，一来避开真实 id 撞车，二来测试里能给出确定的序列。
 * `createdAt` 按 SEEDS 的顺序递增 —— 拓扑排序在同时就绪的节点之间按
 * 创建时间择早，这个顺序决定了合并后上下文读起来是「先限流、后缓存」
 * 而不是两条分支交错在一起。
 */
export function demoGraph(newId: () => string, now: number): Graph {
  const idOf = new Map(SEEDS.map((s) => [s.key, newId()]));
  const nodes: NodeMap = {};

  SEEDS.forEach((seed, i) => {
    const id = idOf.get(seed.key)!;
    nodes[id] = {
      id,
      role: seed.role,
      content: seed.content,
      parentIds: seed.parents.map((p) => idOf.get(p)!),
      position: { x: seed.x, y: seed.y },
      // 每个节点差 1 秒：顺序稳定，看着也像是一路问下来的
      createdAt: now + i * 1000,
      updatedAt: now + i * 1000,
    };
  });

  return {
    id: newId(),
    title: '示例 · 两条分支汇成一个问题',
    nodes,
    createdAt: now,
    updatedAt: now,
  };
}
