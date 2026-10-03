import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// --- 部品の下 (入らなければ上) に出す小さな窓 ---
// 画面の端からはみ出さないように置き、外を押す・Esc・画面のスクロール (部品が動いたとき) や大きさの変化で閉じる
export function Popover({ anchor, onClose, children, className, role, label, matchWidth }: {
  anchor: HTMLElement | null; onClose: () => void; children: ReactNode; className?: string; role?: string; label?: string; matchWidth?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const placed = useRef<{ x: number; y: number } | null>(null); // 置いたときの部品の位置
  useLayoutEffect(() => { close.current = onClose; }); // (いちばん新しい onClose を使う)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect(), M = 8;
    placed.current = { x: a.left, y: a.top };
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
    // (開く直前のスクロールの知らせが、開いたあとに届くことがあるので、部品が動いていなければ閉じない)
    const onScroll = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      const a = anchor?.getBoundingClientRect(), p = placed.current;
      if (a && p && Math.abs(a.left - p.x) < 1 && Math.abs(a.top - p.y) < 1) return;
      close.current();
    };
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
