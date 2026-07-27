import { describe, expect, it } from 'vitest';
import {
  buildUserContent,
  contentToText,
  countImages,
  detectAttachmentKind,
  formatBytes,
  MAX_TEXT_CHARS,
  type ResolvedAttachment,
} from './attachments';

const image = (name: string, url = 'data:image/png;base64,AAAA'): ResolvedAttachment => ({
  id: `i-${name}`,
  name,
  kind: 'image',
  dataUrl: url,
});

const doc = (name: string, text: string): ResolvedAttachment => ({
  id: `t-${name}`,
  name,
  kind: 'text',
  text,
});

describe('detectAttachmentKind', () => {
  it('认得常见图片格式', () => {
    expect(detectAttachmentKind({ name: 'a.png', type: 'image/png' })).toBe('image');
    expect(detectAttachmentKind({ name: 'a.jpg', type: 'image/jpeg' })).toBe('image');
    expect(detectAttachmentKind({ name: 'a.webp', type: 'image/webp' })).toBe('image');
    expect(detectAttachmentKind({ name: 'a.gif', type: 'image/gif' })).toBe('image');
  });

  it('复用知识库那套解析器判断文本类', () => {
    expect(detectAttachmentKind({ name: 'a.md', type: '' })).toBe('text');
    expect(detectAttachmentKind({ name: 'a.docx', type: '' })).toBe('text');
    expect(detectAttachmentKind({ name: 'a.epub', type: '' })).toBe('text');
    expect(detectAttachmentKind({ name: 'a.txt', type: 'text/plain' })).toBe('text');
  });

  /** svg 是可执行的 XML，heic 浏览器解不了，送过去只会是一坨认不出的字节 */
  it('不支持的类型返回 null', () => {
    expect(detectAttachmentKind({ name: 'a.svg', type: 'image/svg+xml' })).toBe(null);
    expect(detectAttachmentKind({ name: 'a.heic', type: 'image/heic' })).toBe(null);
    expect(detectAttachmentKind({ name: 'a.pdf', type: 'application/pdf' })).toBe(null);
    expect(detectAttachmentKind({ name: 'a.exe', type: '' })).toBe(null);
  });
});

describe('buildUserContent', () => {
  /**
   * 这条是最要紧的：不支持多模态的服务端收到数组形式会直接报错。
   * 没有图片就必须和以前一模一样，发纯字符串。
   */
  it('没有附件时返回纯字符串，不包成数组', () => {
    expect(buildUserContent('你好')).toBe('你好');
    expect(buildUserContent('你好', [])).toBe('你好');
  });

  it('只有文本附件时仍然是纯字符串', () => {
    const out = buildUserContent('总结一下', [doc('笔记.md', '正文内容')]);
    expect(typeof out).toBe('string');
    expect(out).toContain('正文内容');
  });

  /** 先给材料再提要求，模型照着答更稳 */
  it('文本附件排在提问前面', () => {
    const out = buildUserContent('这段讲了什么？', [doc('笔记.md', '材料正文')]) as string;
    expect(out.indexOf('材料正文')).toBeLessThan(out.indexOf('这段讲了什么？'));
  });

  it('标出文件名，避免模型把附件当成用户说的话', () => {
    const out = buildUserContent('问题', [doc('季度报告.docx', '内容')]) as string;
    expect(out).toContain('《季度报告.docx》');
    expect(out).toContain('附件');
  });

  it('多个文本附件都展开，各自标名', () => {
    const out = buildUserContent('比较一下', [doc('甲.md', '甲内容'), doc('乙.md', '乙内容')]) as string;
    expect(out).toContain('《甲.md》');
    expect(out).toContain('《乙.md》');
    expect(out).toContain('甲内容');
    expect(out).toContain('乙内容');
  });

  it('有图片时返回内容分段数组', () => {
    const out = buildUserContent('这是什么？', [image('照片.png')]);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([
      { type: 'text', text: '这是什么？' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('多张图片按顺序全部带上', () => {
    const out = buildUserContent('对比这两张', [
      image('a.png', 'data:image/png;base64,A'),
      image('b.png', 'data:image/png;base64,B'),
    ]) as Array<{ type: string }>;
    expect(out.filter((p) => p.type === 'image_url')).toHaveLength(2);
  });

  it('图片和文本附件混在一起时，文字合并成一段放在最前', () => {
    const out = buildUserContent('看图配文', [
      doc('说明.md', '文档正文'),
      image('图.png'),
    ]) as Array<{ type: string; text?: string }>;
    expect(out[0]!.type).toBe('text');
    expect(out[0]!.text).toContain('文档正文');
    expect(out[0]!.text).toContain('看图配文');
    expect(out[1]!.type).toBe('image_url');
  });

  /** 只发图不写字是常见用法，不该多出一段空的 text */
  it('正文为空且只有图片时不产生空的文字段', () => {
    const out = buildUserContent('   ', [image('图.png')]) as Array<{ type: string }>;
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('image_url');
  });

  it('没取到 dataUrl 的图片会被跳过，不发半个空壳', () => {
    const broken: ResolvedAttachment = { id: 'x', name: 'x.png', kind: 'image' };
    expect(buildUserContent('问题', [broken])).toBe('问题');
  });

  it('正文为空的文本附件不占位置', () => {
    expect(buildUserContent('问题', [doc('空.md', '   ')])).toBe('问题');
  });

  /** 一份长文档能把上下文顶爆，截断并说明比静默塞爆强 */
  it('超长文本附件会截断并注明', () => {
    const out = buildUserContent('问', [doc('长文.md', '啊'.repeat(MAX_TEXT_CHARS + 5000))]) as string;
    expect(out).toContain('已截断');
    expect(out.length).toBeLessThan(MAX_TEXT_CHARS + 500);
  });
});

describe('contentToText', () => {
  it('纯字符串原样返回', () => {
    expect(contentToText('你好')).toBe('你好');
  });

  it('数组里只取文字段', () => {
    expect(
      contentToText([
        { type: 'text', text: '一' },
        { type: 'image_url', image_url: { url: 'data:…' } },
        { type: 'text', text: '二' },
      ]),
    ).toBe('一\n二');
  });

  /** 这个函数喂给 token 估算，把 base64 算进去会得到一个荒谬的大数 */
  it('不会把 data URI 当成文字', () => {
    const out = contentToText([{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(9999) } }]);
    expect(out).toBe('');
  });
});

describe('countImages', () => {
  it('数出图片段的个数', () => {
    expect(countImages('纯文字')).toBe(0);
    expect(
      countImages([
        { type: 'text', text: 'x' },
        { type: 'image_url', image_url: { url: 'a' } },
        { type: 'image_url', image_url: { url: 'b' } },
      ]),
    ).toBe(2);
  });
});

describe('formatBytes', () => {
  it('分档显示', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
