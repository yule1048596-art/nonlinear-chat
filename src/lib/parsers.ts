import { unzipSync } from 'fflate';

export type FileKind = 'text' | 'markdown' | 'docx' | 'epub';

export interface ParsedFile {
  kind: FileKind;
  text: string;
  /** 解析过程中的提醒，比如「这个 epub 有 3 章解析失败」，如实告诉用户而不是假装完好 */
  warnings: string[];
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'log', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'htm',
  'js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php',
  'sh', 'sql', 'css', 'scss', 'vue', 'svelte',
]);

export function detectKind(filename: string): FileKind | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
  if (ext === 'docx') return 'docx';
  if (ext === 'epub') return 'epub';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return null;
}

export async function parseFile(file: File): Promise<ParsedFile> {
  const kind = detectKind(file.name);
  if (!kind) {
    throw new Error(`不支持的文件类型：${file.name.split('.').pop() ?? file.name}`);
  }
  if (kind === 'text' || kind === 'markdown') {
    return { kind, text: normalize(await file.text()), warnings: [] };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return kind === 'docx' ? parseDocx(bytes) : parseEpub(bytes);
}

/* ---------- DOCX ---------- */

/**
 * .docx 就是个 zip，正文在 word/document.xml 里。
 * 只取文字：<w:t> 是文本片段，<w:p> 是段落，<w:br>/<w:tab> 是换行和制表。
 * 不做样式转换 —— 知识库要的是内容，不是排版。
 */
export function parseDocx(bytes: Uint8Array): ParsedFile {
  const files = unzipSync(bytes);
  const doc = files['word/document.xml'];
  if (!doc) throw new Error('这个 .docx 里没有 word/document.xml，可能不是有效的 Word 文档');

  const xml = new TextDecoder().decode(doc);
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  if (dom.querySelector('parsererror')) throw new Error('.docx 的 XML 解析失败');

  const paragraphs: string[] = [];
  // 用 localName 匹配，避免依赖 w: 这个前缀（不同生成器可能用别的前缀）
  for (const p of Array.from(dom.getElementsByTagName('*'))) {
    if (p.localName !== 'p') continue;
    let line = '';
    for (const node of Array.from(p.getElementsByTagName('*'))) {
      if (node.localName === 't') line += node.textContent ?? '';
      else if (node.localName === 'tab') line += '\t';
      else if (node.localName === 'br') line += '\n';
    }
    if (line.trim()) paragraphs.push(line.trim());
  }

  const text = normalize(paragraphs.join('\n\n'));
  return {
    kind: 'docx',
    text,
    warnings: text ? [] : ['没抽出任何文字，可能整篇都是图片或文本框'],
  };
}

/* ---------- EPUB ---------- */

/**
 * .epub 也是 zip，但要按阅读顺序拼：
 *   META-INF/container.xml → OPF 路径
 *   OPF 的 <manifest> 给出 id→文件 的映射，<spine> 给出阅读顺序
 * 直接遍历 zip 里所有 xhtml 会打乱章节顺序，也会混进封面、版权页之类。
 */
export function parseEpub(bytes: Uint8Array): ParsedFile {
  const files = unzipSync(bytes);
  const warnings: string[] = [];
  const decoder = new TextDecoder();

  const container = files['META-INF/container.xml'];
  if (!container) throw new Error('这个 .epub 里没有 META-INF/container.xml，可能不是有效的 EPUB');

  const containerDom = new DOMParser().parseFromString(
    decoder.decode(container),
    'application/xml',
  );
  const opfPath = containerDom.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath || !files[opfPath]) throw new Error('EPUB 的 container.xml 没有指向有效的 OPF 文件');

  const opfDom = new DOMParser().parseFromString(decoder.decode(files[opfPath]!), 'application/xml');
  // OPF 里的路径是相对它自己所在目录的
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const hrefById = new Map<string, string>();
  for (const item of Array.from(opfDom.getElementsByTagName('*'))) {
    if (item.localName !== 'item') continue;
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) hrefById.set(id, baseDir + decodeURIComponent(href));
  }

  const order: string[] = [];
  for (const ref of Array.from(opfDom.getElementsByTagName('*'))) {
    if (ref.localName !== 'itemref') continue;
    const idref = ref.getAttribute('idref');
    const href = idref ? hrefById.get(idref) : undefined;
    if (href) order.push(href);
  }
  if (order.length === 0) throw new Error('EPUB 的 spine 是空的，读不出章节顺序');

  const chapters: string[] = [];
  let failed = 0;
  for (const href of order) {
    const raw = files[href];
    if (!raw) {
      failed++;
      continue;
    }
    try {
      const text = xhtmlToText(decoder.decode(raw));
      if (text.trim()) chapters.push(text);
    } catch {
      failed++;
    }
  }
  if (failed) warnings.push(`有 ${failed} 个章节读取失败，已跳过`);

  const text = normalize(chapters.join('\n\n'));
  if (!text) warnings.push('没抽出任何文字');
  return { kind: 'epub', text, warnings };
}

/** XHTML → 纯文本。块级元素之间补换行，否则整章会挤成一行 */
function xhtmlToText(xhtml: string): string {
  const dom = new DOMParser().parseFromString(xhtml, 'text/html');
  for (const el of Array.from(dom.querySelectorAll('script, style'))) el.remove();
  for (const el of Array.from(dom.querySelectorAll('p, div, br, li, h1, h2, h3, h4, h5, h6, tr'))) {
    el.append('\n');
  }
  return dom.body?.textContent ?? '';
}

/* ---------- 公共 ---------- */

/**
 * 统一换行、压掉过多空行、去掉行尾空白。
 * 文档里常见连续十几个空行，原样留着只会白白占 token。
 */
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
