import { useCallback, useRef, useState } from 'react';
import { hexToRgb } from '../../core/hsv';
import { hexToLinear, linearToHex } from '../../core/materials/color';
import type { Color3, SocketDef, SocketValue } from '../../core/materials/nodes';
import { BSlider } from './BSlider';
import { ColorPicker } from './controls/ColorPicker';
import { Popover } from './controls/Popover';

// 色の欄。値はリニアな色 (マテリアルと同じ)、欄には画面の色で見せる。押すと色選びの窓が開く
export function ColorField({ label, value, onChange, compact }: { label: string; value: Color3; onChange: (c: Color3) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const setBtn = useCallback((el: HTMLButtonElement | null) => { btn.current = el; setAnchor(el); }, []); // 窓を出す位置の元 (描くときに使うので state)
  const hex = linearToHex(value);
  return (
    <div className={compact ? 'color-field compact' : 'color-field'}>
      <span>{label}</span>
      <button type="button" ref={setBtn} className="bcolor" aria-label={label} title={`${label} ${hex}`} aria-haspopup="dialog" aria-expanded={open}
              style={{ background: hex }} onClick={() => setOpen(o => !o)} />
      {open && (
        <Popover anchor={anchor} onClose={() => setOpen(false)} className="color-pop" role="dialog" label={`${label}を選ぶ`}>
          <ColorPicker label={label} rgb={hexToRgb(hex)!} onDone={() => { setOpen(false); btn.current?.focus(); }} onChange={c => onChange(hexToLinear(`#${c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`))} />
        </Popover>
      )}
    </div>
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
