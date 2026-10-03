import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// --- 部品の下 (入らなければ上) に出す小さな窓 ---
// 画面の端からはみ出さないように置き、外を押す・Esc・画面のスクロールや大きさの変化で閉じる
export function Popover({ anchor, onClose, children, className, role, label, matchWidth }: {
  anchor: HTMLElement | null; onClose: () => void; children: ReactNode; className?: string; role?: string; label?: string; matchWidth?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect(), M = 8;
    if (matchWidth) el.style.minWidth = `${a.width}px`;
    const w = el.offsetWidth;
    const below = innerHeight - a.bottom - M, above = a.top - M;
    const down = below >= Math.min(el.scrollHeight, 240) || below >= above;
    el.style.maxHeight = `${Math.max(down ? below : above, 80)}px`;
    el.style.left = `${Math.min(Math.max(a.left, M), Math.max(innerWidth - w - M, M))}px`;
    el.style.top = down ? `${a.bottom + 2}px` : `${Math.max(a.top - 2 - Math.min(el.scrollHeight, above), M)}px`;
  });
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor?.contains(t)) close.current();
    };
    const onScroll = (e: Event) => { if (!ref.current?.contains(e.target as Node)) close.current(); };
    const onResize = () => close.current();
    addEventListener('pointerdown', onDown, true);
    addEventListener('scroll', onScroll, true);
    addEventListener('resize', onResize);
    return () => {
      removeEventListener('pointerdown', onDown, true);
      removeEventListener('scroll', onScroll, true);
      removeEventListener('resize', onResize);
    };
  }, [anchor]);
  return createPortal(
    <div ref={ref} className={`popover ${className ?? ''}`} role={role} aria-label={label}
         onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close.current(); anchor?.focus(); } }}>
      {children}
    </div>,
    document.body,
  );
}
