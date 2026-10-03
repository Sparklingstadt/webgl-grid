import { useState } from 'react';
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv, type Hsv } from '../../../core/hsv';

// --- 色選び (Blender の色選びの窓) ---
// 彩度・明度の面と色相のバーをドラッグ (矢印キーでも動く) するか、16 進で打つ。色は画面の色 (sRGB の 0〜1)
// Enter で 16 進を決めたら onDone (窓を閉じる)
export function ColorPicker({ rgb, onChange, label, onDone }: { rgb: [number, number, number]; onChange: (rgb: [number, number, number]) => void; label: string; onDone?: () => void }) {
  // 灰色にしても色相を忘れないように、色相・彩度・明度を自分で持つ (外から色が変わったら合わせ直す)
  const hex = rgbToHex(rgb);
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(rgb));
  const [seen, setSeen] = useState(hex); // 最後に合わせた色 (前の描画の情報は state に持つ)
  if (hex !== seen) {
    setSeen(hex);
    if (hex !== rgbToHex(hsvToRgb(hsv))) setHsv(rgbToHsv(rgb, hsv.h));
  }
  const set = (next: Hsv) => {
    setHsv(next);
    const c = hsvToRgb(next);
    setSeen(rgbToHex(c));
    onChange(c);
  };
  const [draft, setDraft] = useState<string | null>(null);
  const hueColor = rgbToHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 }));
  return (
    <div className="color-picker">
      <Pad2d label={`${label}の彩度と明度`} x={hsv.s} y={hsv.v} style={{ backgroundColor: hueColor }} className="cp-sv"
             onChange={(s, v) => set({ ...hsv, s, v })} />
      <Pad2d label={`${label}の色相`} x={hsv.h / 360} className="cp-hue" onChange={h => set({ ...hsv, h: Math.min(h, 0.9999) * 360 })} />
      <div className="cp-row">
        <span className="cp-swatch" style={{ background: hex }} aria-hidden="true" />
        <input className="text-field" type="text" aria-label={`${label} (16 進)`} spellCheck={false} value={draft ?? hex}
               onFocus={e => e.currentTarget.select()}
               onChange={e => setDraft(e.currentTarget.value)}
               onBlur={() => { const c = draft !== null ? hexToRgb(draft) : null; if (c) set(rgbToHsv(c, hsv.h)); setDraft(null); }}
               onKeyDown={e => {
                 if (e.key === 'Escape') { setDraft(null); return; } // (窓が閉じる)
                 e.stopPropagation();
                 // (Enter をそのままにすると、フォーカスを戻した色のボタンが押されて、また開いてしまう)
                 if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); onDone?.(); }
               }} />
      </div>
    </div>
  );
}

// ドラッグで 0〜1 の値を決める面 (y を渡すと縦も。上が 1)
function Pad2d({ x, y, onChange, label, className, style }: {
  x: number; y?: number; onChange: (x: number, y: number) => void; label: string; className: string; style?: React.CSSProperties;
}) {
  const at = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const cx = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
    const cy = Math.min(Math.max(1 - (e.clientY - r.top) / r.height, 0), 1);
    onChange(cx, y === undefined ? 0 : cy);
  };
  return (
    <div className={className} style={style} role="slider" tabIndex={0} aria-label={label}
         aria-valuenow={Math.round(x * 100)} aria-valuemin={0} aria-valuemax={100}
         aria-valuetext={y === undefined ? `${Math.round(x * 360)}°` : `彩度 ${Math.round(x * 100)}%・明度 ${Math.round(y * 100)}%`}
         onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); at(e); }}
         onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) at(e); }}
         onKeyDown={e => {
           const d = e.shiftKey ? 0.1 : 0.01;
           const k = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[e.key];
           if (!k) return;
           e.preventDefault();
           e.stopPropagation();
           const c = (v: number) => Math.min(Math.max(v, 0), 1);
           onChange(c(x + k[0]), c((y ?? 0) + k[1]));
         }}>
        <span className="cp-knob" style={{ left: `${x * 100}%`, top: y === undefined ? '50%' : `${(1 - y) * 100}%` }} />
    </div>
  );
}
