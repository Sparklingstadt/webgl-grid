import { useLayoutEffect, useRef } from 'react';
import { PALETTE, PALETTE_NAMES, paletteCss, pickColor, ui } from '../engine';
import { useStore } from '../store';

// 画面上部のお知らせ (読み込み中・エラーなど)
export function Toast() {
  const toast = useStore(ui, s => s.toast);
  return <div className="toast" role="status" hidden={!toast}>{toast?.text}</div>;
}

// スマホで形をタップしたときに出す 8 色のパレット。
// タップした位置の上に出し、画面からはみ出す場合は下に出す。左右は端から 16px 以上離す
export function Palette() {
  const palette = useStore(ui, s => s.palette);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !palette) return;
    const w = el.offsetWidth, h = el.offsetHeight, { x, y } = palette;
    el.style.left = `${Math.min(Math.max(x - w / 2, 16), innerWidth - w - 16)}px`;
    el.style.top = `${y - h - 24 >= 16 ? y - h - 24 : Math.min(y + 24, innerHeight - h - 16)}px`;
  }, [palette]);
  if (!palette) return null;
  return (
    <div className="palette" role="group" aria-label="色" ref={ref}>
      {PALETTE.map((_, i) => (
        <button key={i} type="button" aria-label={PALETTE_NAMES[i]} aria-pressed={palette.c === i}
                style={{ background: paletteCss(i) }} onClick={() => pickColor(i)} />
      ))}
    </div>
  );
}
