/**
 * 目标块长（字符）。bge-m3 能吃 8192 token，但块太大检索精度会垮：
 * 一块里塞进五个话题，它和任何一个话题的相似度都不高不低。
 * 中文按 1 字≈1 token 估，600 字对单一话题来说够用了。
 */
export const TARGET_CHARS = 600;

/** 相邻块重叠多少字符。跨越边界的一句话至少在一块里是完整的 */
export const OVERLAP_CHARS = 80;

/** 小于这个长度的尾块并回上一块，避免产生「参考文献」这种三个字的碎片 */
const MIN_CHARS = 120;

export interface Chunk {
  index: number;
  text: string;
  /** 在原文中的起止位置，用来在界面上定位「这段出自文件的哪里」 */
  start: number;
  end: number;
}

/**
 * 把长文切成块。
 *
 * 优先在段落边界切 —— 段落是作者自己划的语义边界，比按固定字数硬切好得多。
 * 只有当单个段落本身就超长时，才退化成按句子、再退化成按字数硬切。
 */
export function chunkText(
  text: string,
  targetChars = TARGET_CHARS,
  overlapChars = OVERLAP_CHARS,
): Chunk[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const pieces = splitToPieces(trimmed, targetChars);

  // 贪心地把小片合并到接近目标长度
  const merged: Array<{ text: string; start: number; end: number }> = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.text.length + piece.text.length + 2 <= targetChars) {
      last.text = `${last.text}\n\n${piece.text}`;
      last.end = piece.end;
    } else {
      merged.push({ ...piece });
    }
  }

  // 太短的尾块并回去，单独存着既占位置又检索不出东西
  if (merged.length > 1) {
    const last = merged[merged.length - 1]!;
    if (last.text.length < MIN_CHARS) {
      const prev = merged[merged.length - 2]!;
      prev.text = `${prev.text}\n\n${last.text}`;
      prev.end = last.end;
      merged.pop();
    }
  }

  return merged.map((m, index) => {
    // 往前借一段重叠，让跨边界的句子不至于两块都读不懂
    const overlapStart = index > 0 ? Math.max(0, m.start - overlapChars) : m.start;
    const prefix = index > 0 ? trimmed.slice(overlapStart, m.start).trimStart() : '';
    return {
      index,
      text: prefix ? `${prefix}${prefix.endsWith('\n') ? '' : ' '}${m.text}` : m.text,
      start: overlapStart,
      end: m.end,
    };
  });
}

/** 先按段落切；超长段落再按句子切；还超长就硬切 */
function splitToPieces(text: string, targetChars: number) {
  const pieces: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;

  for (const paragraph of text.split(/\n{2,}/)) {
    const start = text.indexOf(paragraph, cursor);
    cursor = start + paragraph.length;
    const body = paragraph.trim();
    if (!body) continue;

    if (body.length <= targetChars) {
      pieces.push({ text: body, start, end: start + paragraph.length });
      continue;
    }
    // 段落本身超长：按中英文句末标点切
    let offset = start;
    for (const sentence of splitSentences(body, targetChars)) {
      const at = text.indexOf(sentence, offset);
      const from = at === -1 ? offset : at;
      pieces.push({ text: sentence, start: from, end: from + sentence.length });
      offset = from + sentence.length;
    }
  }
  return pieces;
}

function splitSentences(text: string, targetChars: number): string[] {
  // 中文标点后面通常不跟空格，所以不能只按 /[.!?]\s/ 切
  const parts = text.split(/(?<=[。！？；!?;])\s*|\n/).filter((s) => s.trim());
  const out: string[] = [];
  for (const part of parts) {
    if (part.length <= targetChars) {
      out.push(part);
      continue;
    }
    // 一句话就超长（没有标点的长串），只能硬切
    for (let i = 0; i < part.length; i += targetChars) {
      out.push(part.slice(i, i + targetChars));
    }
  }
  return out;
}
