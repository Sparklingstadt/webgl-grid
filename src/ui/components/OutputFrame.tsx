import { useEffect, useState } from 'react';
import { t } from '../../core/i18n';
import { outputFrame } from '../../core/output';
import { useUi } from '../EngineContext';

// --- ビューポートに重ねる、出力の枠 (Blender のカメラの枠) ---
// レンダリングすると、この枠の中に見えているものが書き出される。枠の外は少し暗くする
export function OutputFrame({ container }: { container: HTMLElement | null }) {
  const o = useUi(s => s.output);
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
    </div>
  );
}

// 出力の枠を出すか (ブラウザに覚えておく)
const KEY = 'webgl-grid-output-frame';
export function useShowFrame(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
  });
  return [on, v => {
    setOn(v);
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* 覚えられなくても使える */ }
  }];
}
