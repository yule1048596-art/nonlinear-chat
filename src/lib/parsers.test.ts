// @vitest-environment happy-dom
// 解析器要用 DOMParser，只有这个文件需要 DOM 环境，其余测试仍跑在 node 下
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { detectKind, parseDocx, parseEpub } from './parsers';

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

/* ---------- docx ---------- */

const docxWith = (bodyXml: string) =>
  zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': `<?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>${bodyXml}</w:body>
      </w:document>`,
  });

const para = (...runs: string[]) => `<w:p>${runs.map((r) => `<w:r><w:t>${r}</w:t></w:r>`).join('')}</w:p>`;

describe('parseDocx', () => {
  it('按段落抽出文字', () => {
    const out = parseDocx(docxWith(para('第一段') + para('第二段')));
    expect(out.text).toBe('第一段\n\n第二段');
    expect(out.kind).toBe('docx');
  });

  it('同一段里的多个文本片段拼在一起', () => {
    // Word 会因为拼写检查、格式变化把一句话拆成多个 run，不拼起来就断成碎片
    expect(parseDocx(docxWith(para('令牌', '桶限流', '算法'))).text).toBe('令牌桶限流算法');
  });

  it('识别换行和制表', () => {
    const out = parseDocx(
      docxWith('<w:p><w:r><w:t>上</w:t><w:br/><w:t>下</w:t><w:tab/><w:t>右</w:t></w:r></w:p>'),
    );
    expect(out.text).toContain('上\n下\t右');
  });

  it('跳过空段落，不留一堆空行', () => {
    expect(parseDocx(docxWith(para('有内容') + '<w:p/>' + para('也有内容'))).text).toBe(
      '有内容\n\n也有内容',
    );
  });

  it('不依赖 w: 这个命名空间前缀', () => {
    const odd = zip({
      'word/document.xml': `<?xml version="1.0"?>
        <x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <x:body><x:p><x:r><x:t>换个前缀也要认</x:t></x:r></x:p></x:body>
        </x:document>`,
    });
    expect(parseDocx(odd).text).toBe('换个前缀也要认');
  });

  it('缺少 document.xml 时报出可读的原因', () => {
    expect(() => parseDocx(zip({ 'foo.txt': 'x' }))).toThrow('word/document.xml');
  });

  it('全是图片没有文字时给出提醒而不是假装成功', () => {
    const out = parseDocx(docxWith('<w:p><w:r><w:drawing/></w:r></w:p>'));
    expect(out.text).toBe('');
    expect(out.warnings.join()).toContain('没抽出任何文字');
  });
});

/* ---------- epub ---------- */

const epub = (opts: {
  opfPath?: string;
  manifest: Array<{ id: string; href: string }>;
  spine: string[];
  chapters: Record<string, string>;
}) => {
  const opfPath = opts.opfPath ?? 'OEBPS/content.opf';
  const dir = opfPath.slice(0, opfPath.lastIndexOf('/') + 1);
  return zip({
    'META-INF/container.xml': `<?xml version="1.0"?>
      <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles>
      </container>`,
    [opfPath]: `<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf">
        <manifest>${opts.manifest.map((m) => `<item id="${m.id}" href="${m.href}" media-type="application/xhtml+xml"/>`).join('')}</manifest>
        <spine>${opts.spine.map((id) => `<itemref idref="${id}"/>`).join('')}</spine>
      </package>`,
    ...Object.fromEntries(Object.entries(opts.chapters).map(([href, html]) => [dir + href, html])),
  });
};

const chapter = (body: string) =>
  `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`;

describe('parseEpub', () => {
  /** 这条是 epub 解析的关键：必须按 spine 的阅读顺序，而不是 zip 里的文件顺序 */
  it('按 spine 顺序拼章节，而不是 zip 里的顺序', () => {
    const out = parseEpub(
      epub({
        manifest: [
          { id: 'c2', href: 'ch2.xhtml' },
          { id: 'c1', href: 'ch1.xhtml' },
        ],
        spine: ['c1', 'c2'], // 阅读顺序和 manifest 顺序相反
        chapters: {
          'ch1.xhtml': chapter('<p>第一章</p>'),
          'ch2.xhtml': chapter('<p>第二章</p>'),
        },
      }),
    );
    expect(out.text.indexOf('第一章')).toBeLessThan(out.text.indexOf('第二章'));
  });

  it('不在 spine 里的文件不进正文（封面、版权页之类）', () => {
    const out = parseEpub(
      epub({
        manifest: [
          { id: 'c1', href: 'ch1.xhtml' },
          { id: 'cover', href: 'cover.xhtml' },
        ],
        spine: ['c1'],
        chapters: {
          'ch1.xhtml': chapter('<p>正文</p>'),
          'cover.xhtml': chapter('<p>这是封面不该出现</p>'),
        },
      }),
    );
    expect(out.text).toContain('正文');
    expect(out.text).not.toContain('封面');
  });

  it('块级元素之间要断行，不能挤成一行', () => {
    const out = parseEpub(
      epub({
        manifest: [{ id: 'c1', href: 'ch1.xhtml' }],
        spine: ['c1'],
        chapters: { 'ch1.xhtml': chapter('<h1>标题</h1><p>段落一</p><p>段落二</p>') },
      }),
    );
    expect(out.text).toContain('标题\n');
    expect(out.text).toContain('段落一\n');
  });

  it('去掉 script 和 style 的内容', () => {
    const out = parseEpub(
      epub({
        manifest: [{ id: 'c1', href: 'ch1.xhtml' }],
        spine: ['c1'],
        chapters: {
          'ch1.xhtml': chapter('<style>.a{color:red}</style><script>var x=1</script><p>正文</p>'),
        },
      }),
    );
    expect(out.text).toBe('正文');
  });

  it('OPF 不在根目录时相对路径也要算对', () => {
    const out = parseEpub(
      epub({
        opfPath: 'deep/nested/content.opf',
        manifest: [{ id: 'c1', href: 'ch1.xhtml' }],
        spine: ['c1'],
        chapters: { 'ch1.xhtml': chapter('<p>嵌套目录</p>') },
      }),
    );
    expect(out.text).toBe('嵌套目录');
  });

  it('href 里的百分号编码要解开', () => {
    const out = parseEpub(
      epub({
        manifest: [{ id: 'c1', href: 'ch%201.xhtml' }],
        spine: ['c1'],
        chapters: { 'ch 1.xhtml': chapter('<p>带空格的文件名</p>') },
      }),
    );
    expect(out.text).toBe('带空格的文件名');
  });

  it('部分章节缺失时如实报告，而不是静默少几章', () => {
    const out = parseEpub(
      epub({
        manifest: [
          { id: 'c1', href: 'ch1.xhtml' },
          { id: 'c2', href: 'missing.xhtml' },
        ],
        spine: ['c1', 'c2'],
        chapters: { 'ch1.xhtml': chapter('<p>在的</p>') },
      }),
    );
    expect(out.text).toBe('在的');
    expect(out.warnings.join()).toContain('1 个章节读取失败');
  });

  it('缺 container.xml 时报出可读原因', () => {
    expect(() => parseEpub(zip({ 'foo.txt': 'x' }))).toThrow('container.xml');
  });

  it('spine 为空时报错而不是返回空文本', () => {
    expect(() =>
      parseEpub(epub({ manifest: [{ id: 'c1', href: 'a.xhtml' }], spine: [], chapters: {} })),
    ).toThrow('spine');
  });
});

describe('detectKind', () => {
  it('认出各类扩展名', () => {
    expect(detectKind('a.md')).toBe('markdown');
    expect(detectKind('a.MARKDOWN')).toBe('markdown');
    expect(detectKind('a.docx')).toBe('docx');
    expect(detectKind('a.epub')).toBe('epub');
    expect(detectKind('a.txt')).toBe('text');
    expect(detectKind('a.ts')).toBe('text');
    expect(detectKind('笔记.TXT')).toBe('text');
  });

  it('不支持的类型返回 null', () => {
    expect(detectKind('a.pdf')).toBeNull();
    expect(detectKind('a.png')).toBeNull();
    expect(detectKind('没有扩展名')).toBeNull();
  });
});
