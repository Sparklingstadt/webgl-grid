import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { t } from '../../core/i18n';
import { normalizeRegion, outputFrame } from '../../core/output';
import { useEngine, useUi } from '../EngineContext';

// --- ビューポートに重ねる、出力の枠 (Blender のカメラの枠) ---
// レンダリングすると、この枠の中に見えているものが書き出される。枠の外は少し暗くする。
// レンダー範囲 (Ctrl+B) があれば、枠の中に赤い点線で出す (その部分だけを書き出す)
export function OutputFrame({ container }: { container: HTMLElement | null }) {
  const o = useUi(s => s.output);
  const r = o.region;
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!container) return;
    const update = () => setSize({ w: container.clientWidth, h: container.clientHeight });
    const ro = new ResizeObserver(update);
    ro.observe(container);
    update();
    return () => ro.disconnect();
  }, [container]);
  if (!size || !size.w || !size.h) return null;
  const f = outputFrame(size.w, size.h, o.width, o.height);
  return (
    <div className="output-frame" role="img" aria-label={t('出力の範囲 {w} × {h}', { w: o.width, h: o.height })}
         style={{ left: f.x, top: f.y, width: f.w, height: f.h }}>
      <span className="output-frame-size">{o.width} × {o.height}</span>
      {r && <div className="render-region" aria-label={t('レンダー範囲')} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} />}
    </div>
  );
}

// 出力の枠を出すか (ブラウザに覚えておく。ビューのメニューと N パネルで同じ値を使う)
const KEY = 'webgl-grid-output-frame';
let frameOn = (() => { try { return localStorage.getItem(KEY) !== '0'; } catch { return true; } })();
const listeners = new Set<() => void>();
const setFrameOn = (v: boolean) => {
  frameOn = v;
  try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* 覚えられなくても使える */ }
  for (const f of listeners) f();
};
export function useShowFrame(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(f => { listeners.add(f); return () => { listeners.delete(f); }; }, () => frameOn);
  return [on, setFrameOn];
}

// --- レンダー範囲を決める (Ctrl+B のあと): ビューポートをドラッグして囲む。出力の枠の中の割合にする。Esc・右クリックでやめる ---
export function RegionSelect({ container }: { container: HTMLElement | null }) {
  const engine = useEngine();
  const on = useUi(s => s.regionSelect);
  const o = useUi(s => s.output);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); engine.ui.set({ regionSelect: false }); setBox(null); } };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [on, engine]);
  if (!on || !container) return null;
  const local = (e: ReactPointerEvent) => { const b = container.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  const finish = () => {
    const b = box;
    start.current = null;
    setBox(null);
    engine.ui.set({ regionSelect: false });
    if (!b) return;
    const f = outputFrame(container.clientWidth, container.clientHeight, o.width, o.height);
    const x0 = (Math.min(b.x0, b.x1) - f.x) / f.w, x1 = (Math.max(b.x0, b.x1) - f.x) / f.w;
    const y0 = (Math.min(b.y0, b.y1) - f.y) / f.h, y1 = (Math.max(b.y0, b.y1) - f.y) / f.h;
    const cx0 = Math.max(x0, 0), cy0 = Math.max(y0, 0);
    const region = normalizeRegion({ x: cx0, y: cy0, w: Math.min(x1, 1) - cx0, h: Math.min(y1, 1) - cy0 });
    if (region) engine.output.set({ region });
  };
  return (
    <div className="region-select" role="application" aria-label={t('レンダー範囲をドラッグで囲む')}
         onPointerDown={e => {
           if (e.button !== 0) { engine.ui.set({ regionSelect: false }); return; }
           e.currentTarget.setPointerCapture(e.pointerId);
           const p = local(e);
           start.current = p;
           setBox({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
         }}
         onPointerMove={e => { if (start.current) { const p = local(e); setBox({ x0: start.current.x, y0: start.current.y, x1: p.x, y1: p.y }); } }}
         onPointerUp={finish} onContextMenu={e => e.preventDefault()}>
      {box && <div className="select-box" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />}
      <div className="view-mode-hint">{t('レンダー範囲: 出力の枠の中をドラッグで囲む (Esc でやめる・Ctrl+Alt+B で消す)')}</div>
    </div>
  );
}
