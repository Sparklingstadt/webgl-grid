import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

// Blender の数値スライダー: 暗い地に値の分だけ青い帯を引き、中に名前と値を書く。
// 左右にドラッグで値を変える。マウスで動かさずにクリック (またはダブルクリック・Enter) すると数値を打てる。
// タッチは触った位置の値になる。0 をまたぐ範囲 (−180〜180 など) は、0 から値までに帯を引く
interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits?: number;
  unit?: string;
  off?: boolean; // 効果がオフのときは帯を暗くする
  onChange: (v: number) => void;
}

export function BSlider({ label, value, min, max, step, digits = 2, unit = '', off, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; moved: boolean; type: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const clamp = (v: number) => Math.min(Math.max(Math.round(v / step) * step, min), max);
  const fromX = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return clamp(min + (clientX - r.left) / r.width * (max - min));
  };
  const set = (v: number) => {
    if (!Number.isFinite(v)) return;
    const c = clamp(v);
    if (c !== value) onChange(c); // 端でさらに押したときなど、変わらないなら知らせない
  };
  const pct = (v: number) => (v - min) / (max - min) * 100;
  const zero = min < 0 && max > 0 ? pct(0) : 0;
  const left = Math.min(zero, pct(value)), width = Math.abs(pct(value) - zero);

  const onPointerDown = (e: PointerEvent) => {
    if (editing || e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, moved: false, type: e.pointerType };
    ref.current!.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.abs(e.clientX - d.x) < 4) return;
    d.moved = true;
    set(fromX(e.clientX));
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.moved) return;
    if (d.type === 'mouse') setEditing(true);
    else set(fromX(e.clientX));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { set(value - step * k); e.preventDefault(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { set(value + step * k); e.preventDefault(); }
    else if (e.key === 'Enter') { setEditing(true); e.preventDefault(); }
  };

  return (
    <div ref={ref} className={`bslider${off ? ' off' : ''}`} role="slider" tabIndex={0} aria-label={label}
         aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} title={label}
         onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
         onPointerCancel={() => { drag.current = null; }} onKeyDown={onKeyDown}>
      <div className="fill" style={{ left: `${left}%`, width: `${width}%` }} />
      <span className="name">{label}</span>
      <span className="val">{value.toFixed(digits)}{unit}</span>
      {editing && (
        <input type="number" autoFocus defaultValue={+value.toFixed(digits)} step={step}
               onFocus={e => e.currentTarget.select()}
               onBlur={e => { set(+e.currentTarget.value); setEditing(false); }}
               onKeyDown={e => {
                 e.stopPropagation();
                 if (e.key === 'Enter') e.currentTarget.blur();
                 if (e.key === 'Escape') { e.currentTarget.value = String(value); e.currentTarget.blur(); }
               }} />
      )}
    </div>
  );
}
