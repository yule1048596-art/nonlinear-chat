/**
 * 视图模式。
 *
 * - `edit` 现在这个画布：完整卡片，能读能改
 * - `map`  地图视图：紧凑卡片重新排一遍，看结构而不是看内容
 *
 * 地图视图用**自己的一套坐标**：节点只有 84px 高，却按 200 多像素高的卡片
 * 排版的话，每个节点上下都空着五六倍于自身的留白，边被拉成又长又细的折线，
 * 看着就是一张稀疏的表格而不是一张图。
 *
 * 坐标不同本来会切断空间记忆，靠切换时的**滑动动画**补回来 ——
 * 节点是滑过去而不是瞬移，眼睛能跟住每一个去了哪儿。
 * 这套位置不写回数据、不进撤销栈，纯粹是渲染层的事。
 */
export type ViewMode = 'edit' | 'map';

/** 和主题一样存 localStorage：这是纯视图偏好，不该进画布数据 */
export const VIEW_KEY = 'nexus-view';

export function loadViewMode(): ViewMode {
  return localStorage.getItem(VIEW_KEY) === 'map' ? 'map' : 'edit';
}

export function saveViewMode(mode: ViewMode): void {
  localStorage.setItem(VIEW_KEY, mode);
}

export const VIEW_LABEL: Record<ViewMode, string> = {
  edit: '编辑',
  map: '地图',
};

/*
 * 地图视图的卡片尺寸是**固定**的：摘要按两行截断，所有卡片一样大。
 * 这样排出来是整齐的网格，而不是高矮不齐的一堆方块 —— 密度上去了，
 * 好看与否主要就取决于这一点。尺寸写死也让布局能在渲染前就算出来。
 */
export const MAP_NODE_WIDTH = 232;
export const MAP_NODE_HEIGHT = 84;
/** 同层间距。参考图里的节点几乎是挨着的，留白靠卡片自身的内边距给 */
export const MAP_NODE_SEP = 26;
export const MAP_RANK_SEP = 46;

const RULES: Array<[RegExp, string]> = [
  // 代码块围栏整行去掉，只留里面的代码
  [/^```+.*$/gm, ' '],
  // 标题、引用、无序列表、有序列表的前导记号
  [/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, ''],
  // 表格分隔行整行丢掉，只留 |
  [/^\s*\|?[\s:|-]{4,}\|?\s*$/gm, ' '],
  // 图片先于链接处理，否则 ![x](y) 会剩一个孤零零的 !
  [/!\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  // 行内代码、粗体、斜体、删除线的记号
  [/`+([^`]*)`+/g, '$1'],
  [/(\*\*|__|~~)(.*?)\1/g, '$2'],
  [/(?<![\w*])\*([^*\n]+)\*(?!\w)/g, '$1'],
];

/**
 * 把正文压成一行标题。
 *
 * 直接取首行是不够的：Markdown 正文的第一行常常是 `## 标题` 或者 ```` ```ts ````，
 * 前者会带一串井号，后者更糟 —— 整行只有语言名，等于什么都没说。
 * 所以先剥掉记号，再取第一段有实际内容的文字。
 */
export function summarize(content: string, maxChars = 48): string {
  let text = content;
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);

  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';

  const clean = line.replace(/\s+/g, ' ').trim();
  // 用数组下标截断而不是 slice：emoji 这类代理对被切一半会变成乱码方块
  const chars = [...clean];
  return chars.length <= maxChars ? clean : `${chars.slice(0, maxChars).join('')}…`;
}
