import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';

// Blender のヘッダーのメニュー。押すと開き、開いているあいだは隣のメニューに触れるだけで切り替わる。
// 外を押すか Esc で閉じる (App が見ている)
export const MenuContext = createContext<{ open: string | null; setOpen: (id: string | null) => void }>({
  open: null, setOpen: () => {},
});

export function Menu({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const { open, setOpen } = useContext(MenuContext);
  const isOpen = open === id;
  const popRef = useRef<HTMLDivElement>(null);
  // 画面の右端からはみ出すなら左へずらす
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!isOpen || !pop) return;
    pop.style.left = '0px';
    const r = pop.getBoundingClientRect();
    if (r.right > innerWidth - 4) pop.style.left = `${innerWidth - 4 - r.right}px`;
  }, [isOpen]);
  return (
    <div className="menu">
      <button type="button" className="hbtn" aria-haspopup="true" aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : id)}
              onPointerEnter={() => { if (open && open !== id) setOpen(id); }}>
        {label}
      </button>
      {isOpen && (
        <div className="menu-pop" role="menu" ref={popRef}
             onClick={e => { if ((e.target as HTMLElement).closest('button:not(:disabled)')) setOpen(null); }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ label, kbd, onSelect, disabled }: { label: string; kbd?: string; onSelect?: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onSelect}>
      {label}{kbd && <kbd>{kbd}</kbd>}
    </button>
  );
}

export const MenuSep = () => <hr />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="menu-label">{children}</div>;
