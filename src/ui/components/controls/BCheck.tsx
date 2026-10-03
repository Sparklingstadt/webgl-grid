import type { ReactNode } from 'react';

// --- チェックボックス (Blender の四角いチェック) ---
// パネルの見出しの中に置いても、押したときにパネルは開け閉めしない
export function BCheck({ checked, onChange, label, children, disabled }: {
  checked: boolean; onChange: (on: boolean) => void; label?: string; children?: ReactNode; disabled?: boolean;
}) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} disabled={disabled}
            className={children ? 'bcheck' : 'bcheck bare'}
            onClick={e => { e.preventDefault(); e.stopPropagation(); onChange(!checked); }}>
      <span className="bcheck-box" aria-hidden="true" />
      {children && <span className="bcheck-text">{children}</span>}
    </button>
  );
}

// --- 進み具合のバー ---
export function BProgress({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(Math.max(value / max, 0), 1) * 100 : 0;
  return (
    <div className="bprogress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <div className="bprogress-bar" style={{ width: `${pct}%` }} />
    </div>
  );
}
