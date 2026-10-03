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
