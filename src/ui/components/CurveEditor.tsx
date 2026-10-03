import { useRef } from 'react';
import { CURVE_PRESETS, type Curve } from '../../core/animation';
import { t } from '../../core/i18n';
import { BSelect } from './controls/BSelect';
import { NumField } from './NumField';

// --- 補間曲線 (MMD の補間曲線のパネル) ---
// 前のキーからこのキーまでの進み方。横が時間、縦が進み具合。2 つの点をドラッグする (矢印キーでも動く)
const SIZE = 160, PAD = 8;

export function CurveEditor({ curve, onChange, label }: { curve: Curve; onChange: (c: Curve) => void; label: string }) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<0 | 1 | null>(null);
  const [x1, y1, x2, y2] = curve;
  const px = (v: number) => PAD + v * SIZE, py = (v: number) => PAD + (1 - v) * SIZE;
  const clamp = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 100) / 100;
  const set = (i: 0 | 1, x: number, y: number) => {
    const c = [...curve] as Curve;
    c[i * 2] = clamp(x);
    c[i * 2 + 1] = clamp(y);
    onChange(c);
  };
  const at = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect(), k = (SIZE + PAD * 2) / r.width;
    return [((e.clientX - r.left) * k - PAD) / SIZE, 1 - ((e.clientY - r.top) * k - PAD) / SIZE] as const;
  };
  const preset = CURVE_PRESETS.findIndex(p => p.curve.every((v, i) => Math.abs(v - curve[i]) < 1e-6));
  const handle = (i: 0 | 1) => {
    const hx = curve[i * 2], hy = curve[i * 2 + 1];
    return (
      <circle cx={px(hx)} cy={py(hy)} r={6} className="curve-handle" tabIndex={0} role="slider"
              aria-label={t('{label}の点 {n}', { label, n: i + 1 })} aria-valuenow={hx} aria-valuetext={t('横 {x}・縦 {y}', { x: hx, y: hy })}
              onPointerDown={e => { e.stopPropagation(); drag.current = i; svg.current!.setPointerCapture(e.pointerId); }}
              onKeyDown={e => {
                const d = e.shiftKey ? 0.1 : 0.01;
                const k = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[e.key];
                if (!k) return;
                e.preventDefault();
                e.stopPropagation();
                set(i, hx + k[0], hy + k[1]);
              }} />
    );
  };
  return (
    <div className="curve-editor">
      <svg ref={svg} viewBox={`0 0 ${SIZE + PAD * 2} ${SIZE + PAD * 2}`} role="group" aria-label={label}
           onPointerMove={e => { if (drag.current !== null) { const [x, y] = at(e); set(drag.current, x, y); } }}
           onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <rect x={PAD} y={PAD} width={SIZE} height={SIZE} className="curve-bg" />
        <line x1={px(0)} y1={py(0)} x2={px(1)} y2={py(1)} className="curve-diag" />
        <line x1={px(0)} y1={py(0)} x2={px(x1)} y2={py(y1)} className="curve-arm" />
        <line x1={px(1)} y1={py(1)} x2={px(x2)} y2={py(y2)} className="curve-arm" />
        <path d={`M${px(0)},${py(0)} C${px(x1)},${py(y1)} ${px(x2)},${py(y2)} ${px(1)},${py(1)}`} className="curve-line" />
        {handle(0)}
        {handle(1)}
      </svg>
      <div className="prop">
        <label>{t('形')}</label>
        <BSelect label={t('{label}の形', { label })} value={preset} placeholder={t('カスタム')} onChange={i => onChange([...CURVE_PRESETS[i].curve] as Curve)}
                 options={CURVE_PRESETS.map((p, i) => ({ value: i, label: t(p.name) }))} />
        <label>{t('点 1')}</label>
        <div className="row">
          <NumField label={t('{label}の点 1 の横', { label })} value={x1} min={0} max={1} step={0.01} digits={2} onCommit={v => set(0, v, y1)} />
          <NumField label={t('{label}の点 1 の縦', { label })} value={y1} min={0} max={1} step={0.01} digits={2} onCommit={v => set(0, x1, v)} />
        </div>
        <label>{t('点 2')}</label>
        <div className="row">
          <NumField label={t('{label}の点 2 の横', { label })} value={x2} min={0} max={1} step={0.01} digits={2} onCommit={v => set(1, v, y2)} />
          <NumField label={t('{label}の点 2 の縦', { label })} value={y2} min={0} max={1} step={0.01} digits={2} onCommit={v => set(1, x2, v)} />
        </div>
      </div>
    </div>
  );
}
