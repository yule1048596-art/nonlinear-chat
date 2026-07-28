import { useLayoutEffect, useRef } from 'react';

/**
 * 随内容长高的文本框。编辑视图的节点和聚焦视图的提问共用一个。
 *
 * 抽出来不只是为了少写一遍：聚焦视图当初直接把提问渲染成只读文本，
 * 结果「追问」建出来的空节点根本没地方填内容 —— 一个能写字的输入框
 * 本来就该是这两处共同的基础件。
 */
export function AutoTextarea({
  value,
  placeholder,
  onChange,
  onSubmit,
  className = 'node-input nodrag nowheel',
  maxHeight = 400,
  autoFocus,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  className?: string;
  maxHeight?: number;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    };
    fit();

    /*
     * 只量一次是不够的：量的那一刻宽度可能还没定下来。
     *
     * textarea 没给显式宽度时按 cols=20 算，六个中文字会被挤成六行 ——
     * 于是量出 148px 存下来，等宽度真正撑开也不会再重测，
     * 一行字的输入框就永远顶着六行的高度。
     *
     * 所以宽度一变就重量。只认宽度：高度是我们自己改的，跟着它重量会绕回来。
     */
    let lastWidth = el.getBoundingClientRect().width;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width === lastWidth) return;
      lastWidth = width;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [value, maxHeight]);

  return (
    <textarea
      ref={ref}
      /*
       * rows=1 不能省。textarea 默认 rows=2，height:auto 时 scrollHeight
       * 至少返回两行 —— 于是每个只有一行字的节点都白占一行的高度，
       * 卡片底部那截「怎么调 padding 都消不掉的空白」就是从这来的。
       */
      rows={1}
      className={className}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (onSubmit && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onSubmit();
        }
        // 别让画布把删除键当成「删除选中节点」
        e.stopPropagation();
      }}
    />
  );
}
