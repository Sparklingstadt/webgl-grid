import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Popover } from './Popover';

// --- 選択肢 (Blender のドロップダウン) ---
// ボタンを押すと一覧が開く。開いているあいだも、キーボードの操作はボタンが受ける (aria-activedescendant)
//   ↑↓ (開いていなくても) で前後、Home / End、Enter / Space で決める・開く、Esc / Tab で閉じる、文字で頭から探す
export interface SelectOption<T> { value: T; label: string; disabled?: boolean }
export interface SelectGroup<T> { group: string; options: SelectOption<T>[] }

export function BSelect<T extends string | number>({ value, options, onChange, label, id, className, placeholder = '' }: {
  value: T | null; options: (SelectOption<T> | SelectGroup<T>)[]; onChange: (v: T) => void;
  label: string; id?: string; className?: string; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const btn = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const setBtn = useCallback((el: HTMLButtonElement | null) => { btn.current = el; setAnchor(el); }, []); // 一覧を出す位置の元 (描くときに使うので state)
  const listId = useId();
  const flat = options.flatMap(o => ('group' in o ? o.options : [o]));
  const cur = flat.findIndex(o => o.value === value);
  const enabled = (i: number) => i >= 0 && i < flat.length && !flat[i].disabled;
  const step = (from: number, d: number) => {
    for (let i = from + d; i >= 0 && i < flat.length; i += d) if (enabled(i)) return i;
    return from;
  };
  // 選んでいる行が見えるように一覧をスクロールする
  useEffect(() => { if (open && active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [open, active, listId]);
  const show = () => { setActive(cur >= 0 ? cur : step(-1, 1)); setOpen(true); };
  const pick = (i: number) => {
    setOpen(false);
    if (enabled(i) && flat[i].value !== value) onChange(flat[i].value);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    let handled = true;
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp') { const i = step(cur, k === 'ArrowDown' ? 1 : -1); if (i !== cur) pick(i); }
      else if (k === 'Enter' || k === ' ' || (k === 'ArrowDown' && e.altKey)) show();
      else handled = false;
    } else if (k === 'ArrowDown' || k === 'ArrowUp') setActive(a => step(a, k === 'ArrowDown' ? 1 : -1));
    else if (k === 'Home') setActive(step(-1, 1));
    else if (k === 'End') setActive(step(flat.length, -1));
    else if (k === 'Enter' || k === ' ') pick(active);
    else if (k === 'Escape') setOpen(false);
    else if (k === 'Tab') { setOpen(false); handled = false; }
    else if (k.length === 1) {
      // 文字: その文字で始まる次の選択肢へ
      const start = active < 0 ? 0 : active + 1;
      const order = [...flat.keys()].map(i => (start + i) % flat.length);
      const hit = order.find(i => enabled(i) && flat[i].label.toLowerCase().startsWith(k.toLowerCase()));
      if (hit !== undefined) setActive(hit);
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };
  let n = -1;
  const optionEl = (o: SelectOption<T>) => {
    const i = ++n;
    return (
      <div key={`${i}:${o.value}`} id={`${listId}-${i}`} role="option" aria-selected={i === cur} aria-disabled={o.disabled || undefined}
           className={i === active ? 'active' : undefined}
           onPointerEnter={() => { if (enabled(i)) setActive(i); }}
           onClick={() => { if (enabled(i)) { pick(i); btn.current?.focus(); } }}>
        {o.label}
      </div>
    );
  };
  return (
    <>
      <button type="button" ref={setBtn} id={id} className={`bselect ${className ?? ''}`} role="combobox" aria-label={label} title={label}
              aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
              aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
              onClick={() => (open ? setOpen(false) : show())} onKeyDown={onKey}>
        <span className="bselect-text">{cur >= 0 ? flat[cur].label : placeholder}</span>
      </button>
      {open && (
        <Popover anchor={anchor} onClose={() => setOpen(false)} className="bselect-pop" matchWidth>
          <div id={listId} role="listbox" aria-label={label}>
            {options.map(o => ('group' in o
              ? <div key={`g:${o.group}`} role="group" aria-label={o.group}><div className="bselect-group" aria-hidden="true">{o.group}</div>{o.options.map(optionEl)}</div>
              : optionEl(o)))}
          </div>
        </Popover>
      )}
    </>
  );
}
