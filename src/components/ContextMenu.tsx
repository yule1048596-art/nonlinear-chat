import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  hint?: string;
  onSelect: () => void;
  danger?: boolean;
}

export interface MenuAnchor {
  x: number;
  y: number;
}

/**
 * 极简右键菜单。不引第三方库——需求就是「一列按钮 + 点外面关掉」。
 * 用 fixed 定位，因此传入的坐标是视口坐标（clientX/clientY）。
 */
export function ContextMenu({
  anchor,
  items,
  onClose,
}: {
  anchor: MenuAnchor | null;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuAnchor | null>(anchor);

  useLayoutEffect(() => {
    if (!anchor) {
      setPos(null);
      return;
    }
    // 先按原位置放，量完尺寸再把超出视口的部分收回来
    const el = ref.current;
    if (!el) {
      setPos(anchor);
      return;
    }
    const { width, height } = el.getBoundingClientRect();
    // 上下限都要夹：只夹上限的话，菜单比窗口还宽时会被推到负坐标、整个飞出屏幕左边
    const clamp = (v: number, size: number, viewport: number) =>
      Math.max(8, Math.min(v, viewport - size - 8));
    setPos({
      x: clamp(anchor.x, width, window.innerWidth),
      y: clamp(anchor.y, height, window.innerHeight),
    });
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation(); // 别让 App 顺手把抽屉也关了
        onClose();
      }
    };
    // capture 阶段监听，保证点在画布上也能收到
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

  if (!anchor) return null;

  // 必须 portal 到 body：菜单可能渲染在节点内部，而 React Flow 的 viewport
  // 带 transform，会成为 position:fixed 的包含块，直接渲染会定位到错误的地方。
  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      style={{ left: (pos ?? anchor).x, top: (pos ?? anchor).y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          className={item.danger ? 'context-menu-item danger' : 'context-menu-item'}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          <span>{item.label}</span>
          {item.hint && <span className="context-menu-hint">{item.hint}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
