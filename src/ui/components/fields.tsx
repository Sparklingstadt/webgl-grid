import { useRef, useState } from 'react';
import { hexToLinear, linearToHex } from '../../core/materials/color';
import type { Color3, SocketDef, SocketValue } from '../../core/materials/nodes';
import { BSlider } from './BSlider';

// 色の欄。値はリニアな色 (マテリアルと同じ)、欄には画面の色で見せる
export function ColorField({ label, value, onChange, compact }: { label: string; value: Color3; onChange: (c: Color3) => void; compact?: boolean }) {
  return (
    <label className={compact ? 'color-field compact' : 'color-field'}>
      <span>{label}</span>
      <input type="color" value={linearToHex(value)} aria-label={label} onChange={e => onChange(hexToLinear(e.currentTarget.value))} />
    </label>
  );
}

// ノードの入力の値の欄 (色なら色の欄、値ならスライダー)
export function SocketField({ def, value, onChange, compact }: { def: SocketDef; value: SocketValue | undefined; onChange: (v: SocketValue) => void; compact?: boolean }) {
  if (def.noValue || value === undefined) return <span className="socket-label">{def.label}</span>;
  if (def.kind === 'color') return <ColorField label={def.label} value={value as Color3} onChange={onChange} compact={compact} />;
  const step = def.step ?? 0.01;
  return (
    <BSlider label={def.label} value={value as number} min={def.min ?? 0} max={def.max ?? 1} step={step}
             digits={step >= 0.05 ? 2 : 3} onChange={onChange} />
  );
}

// 文字の欄。Enter か欄を離れたときに決める (Esc でやめる)
export function TextField({ value, label, onCommit }: { value: string; label: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancel = useRef(false);
  return (
    <input className="text-field" type="text" aria-label={label} title={label} value={draft ?? value}
           onFocus={e => { cancel.current = false; e.currentTarget.select(); }}
           onChange={e => setDraft(e.currentTarget.value)}
           onBlur={e => {
             const v = e.currentTarget.value.trim();
             if (!cancel.current && draft !== null && v && v !== value) onCommit(v);
             setDraft(null);
           }}
           onKeyDown={e => {
             e.stopPropagation(); // 打っているあいだはショートカットを効かせない
             if (e.key === 'Enter') e.currentTarget.blur();
             if (e.key === 'Escape') { cancel.current = true; e.currentTarget.blur(); }
           }} />
  );
}
