import type { ContentPart } from '../types';
import { contentToText, countImages } from './attachments';

/**
 * 粗略的 token 估算。
 *
 * 为什么不用真正的分词器：tiktoken 之类的词表动辄几 MB，为了在状态栏显示
 * 一个数字而让首屏多下载几兆不划算。这里只需要「量级对」——用户要判断的是
 * 「这一发是 800 还是 8000」，不是精确计费。
 *
 * 比字符数强在哪：中文和英文的 token 密度差三四倍。一段 500 字的中文和
 * 500 字符的英文，前者的 token 数是后者的三倍多。只报字符数会严重误导。
 *
 * 系数取自常见分词器的中间值。现代中文模型（DeepSeek / Qwen / MiMo）词表大，
 * 中文约 0.6~1 token/字；英文经典经验值是 4 字符/token。
 */

// 中日韩统一表意文字 + 扩展A + 兼容表意文字 + 假名 + 谚文
const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/gu;

const CJK_TOKENS_PER_CHAR = 0.9;
const LATIN_CHARS_PER_TOKEN = 3.8;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // 用一次原生 match 数出 CJK 字符数，比逐字符跑正则快得多
  const cjk = text.match(CJK_PATTERN)?.length ?? 0;
  const rest = text.length - cjk;
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + rest / LATIN_CHARS_PER_TOKEN);
}

/**
 * 一张图占多少 token。
 *
 * 各家算法不同（OpenAI 按 512px 瓦片数，低细节固定 85），而且要真算就得先解出
 * 图片尺寸 —— 状态栏那个数只需要量级对，取一个中间的常数就够了。
 */
export const IMAGE_TOKENS = 800;

export function estimateMessageTokens(
  messages: Array<{ content: string | ContentPart[] }>,
): number {
  return messages.reduce((sum, m) => {
    // 每条消息在 chat 模板里还要包一层角色标记，按经验补 4 个
    const text = estimateTokens(contentToText(m.content)) + 4;
    return sum + text + countImages(m.content) * IMAGE_TOKENS;
  }, 0);
}

/** 1234 → "1.2k"，状态栏放不下完整数字 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
