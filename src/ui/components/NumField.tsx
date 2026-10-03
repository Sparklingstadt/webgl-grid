import { useRef, useState } from 'react';

// --- 数値の欄 (Blender の数値フィールド) ---
// 左右にドラッグすると値が変わり、両端の ‹ › で 1 段ずつ増減、クリックすると打ち込める。
// 打っているあいだは打った文字のまま、Enter か欄を離れたときに決める (Esc でやめる)。↑↓ で 1 段ずつ
const DRAG_PX = 4; // 1 段ぶん動かすのに必要なドラッグの量 (ピクセル)

export function NumField({ value, onCommit, label, id, min, max, step = 1, digits = 0 }: {
  value: number; onCommit: (v: number) => void; label: string; id?: string; min?: number; max?: number; step?: number; digits?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const cancel = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; start: number; moved: boolean; id: number } | null>(null);
  const clamp = (v: number) => Math.min(Math.max(v, min ?? -Infinity), max ?? Infinity);
  const round = (v: number) => +clamp(Math.round(v / step) * step).toFixed(Math.max(digits, 6));
  const commit = (v: number) => { const r = round(v); if (r !== value) onCommit(r); };
  const shown = draft ?? (digits ? value.toFixed(digits) : String(value));
  return (
    <div className={`bnum${editing ? ' editing' : ''}`}>
      <button type="button" className="bnum-arrow" tabIndex={-1} aria-label={`${label}を減らす`} onClick={() => commit(value - step)}>‹</button>
      <input ref={input} className="num" type="text" inputMode="decimal" role="spinbutton" id={id} aria-label={label} title={label}
             aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} value={shown} autoComplete="off" spellCheck={false}
             onPointerDown={e => {
               if (editing || e.button !== 0) return;
               // 打ち込み中でなければ、まずドラッグかクリックかを見分ける
               e.preventDefault();
               e.currentTarget.setPointerCapture(e.pointerId);
               drag.current = { x: e.clientX, start: value, moved: false, id: e.pointerId };
             }}
             onPointerMove={e => {
               const d = drag.current;
               if (!d || d.id !== e.pointerId) return;
               const dx = e.clientX - d.x;
               if (!d.moved && Math.abs(dx) < 3) return;
               d.moved = true;
               commit(d.start + Math.round(dx / DRAG_PX) * step);
             }}
             onPointerUp={e => {
               const d = drag.current;
               drag.current = null;
               if (!d || d.moved) return;
               e.currentTarget.releasePointerCapture(e.pointerId);
               e.currentTarget.focus(); // クリックだけなら打ち込む
             }}
             onPointerCancel={() => { drag.current = null; }}
             onFocus={e => { cancel.current = false; setEditing(true); e.currentTarget.select(); }}
             onChange={e => setDraft(e.currentTarget.value)}
             onBlur={e => {
               const v = e.currentTarget.value.trim();
               if (!cancel.current && draft !== null && v !== '' && Number.isFinite(+v)) onCommit(clamp(+v));
               setDraft(null);
               setEditing(false);
             }}
             onKeyDown={e => {
               e.stopPropagation(); // 数字を打つあいだはショートカットを効かせない
               if (e.key === 'Enter') e.currentTarget.blur();
               else if (e.key === 'Escape') { cancel.current = true; e.currentTarget.blur(); }
               else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                 e.preventDefault();
                 const base = draft !== null && Number.isFinite(+draft) ? +draft : value;
                 setDraft(null);
                 commit(base + (e.key === 'ArrowUp' ? step : -step));
                 requestAnimationFrame(() => input.current?.select());
               }
             }} />
      <button type="button" className="bnum-arrow" tabIndex={-1} aria-label={`${label}を増やす`} onClick={() => commit(value + step)}>›</button>
    </div>
  );
}
