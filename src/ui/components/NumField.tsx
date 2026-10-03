import { useRef, useState } from 'react';

// 数値の欄。打っているあいだは打った文字のまま、Enter か欄を離れたときに決める (Esc でやめる)
export function NumField({ value, onCommit, label, id, min, step = 1, digits = 0 }: {
  value: number; onCommit: (v: number) => void; label: string; id?: string; min?: number; step?: number; digits?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancel = useRef(false);
  const shown = draft ?? (digits ? value.toFixed(digits) : String(value));
  return (
    <input className="num" type="number" id={id} aria-label={label} title={label} min={min} step={step} value={shown}
           onFocus={e => { cancel.current = false; e.currentTarget.select(); }}
           onChange={e => setDraft(e.currentTarget.value)}
           onBlur={e => {
             const v = e.currentTarget.value;
             if (!cancel.current && draft !== null && v.trim() !== '' && Number.isFinite(+v)) onCommit(+v);
             setDraft(null);
           }}
           onKeyDown={e => {
             e.stopPropagation(); // 数字を打つあいだはショートカットを効かせない
             if (e.key === 'Enter') e.currentTarget.blur();
             if (e.key === 'Escape') { cancel.current = true; e.currentTarget.blur(); }
           }} />
  );
}
