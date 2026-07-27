/**
 * 视图模式。
 *
 * - `edit` 现在这个画布：完整卡片，能读能改
 * - `map`  地图视图：每个节点压成一行，看结构而不是看内容
 *
 * 地图视图刻意**不动节点坐标** —— 同一个节点在两个视图里位置一致，
 * 空间记忆才不会断。节点只是变矮，连线因此成为视觉主体，
 * 而多父合并这件事恰好只有在缩小之后才看得出来。
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

/** 地图视图里节点固定这么高，一行的事 */
export const MAP_NODE_HEIGHT = 36;

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
