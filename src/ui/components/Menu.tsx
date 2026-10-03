import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';

// Blender のヘッダーのメニュー。押すと開き、開いているあいだは隣のメニューに触れるだけで切り替わる。
// 外を押すか Esc で閉じる (App が見ている)。
// 窓は画面に固定して置く (領域の外にはみ出しても切れない)。画面の下に入りきらなければ、中で上下に動かす
export const MenuContext = createContext<{ open: string | null; setOpen: (id: string | null) => void }>({
  open: null, setOpen: () => {},
});

export function Menu({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const { open, setOpen } = useContext(MenuContext);
  const isOpen = open === id;
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // ボタンの下に置く。画面の右端からはみ出すなら左へずらす
  useLayoutEffect(() => {
    const pop = popRef.current, btn = btnRef.current;
    if (!isOpen || !pop || !btn) return;
    const b = btn.getBoundingClientRect();
    pop.style.top = `${b.bottom + 2}px`;
    pop.style.maxHeight = `${innerHeight - b.bottom - 8}px`;
    pop.style.left = `${Math.max(Math.min(b.left, innerWidth - 4 - pop.offsetWidth), 4)}px`;
  }, [isOpen]);
  return (
    <div className="menu">
      <button type="button" className="hbtn" aria-haspopup="true" aria-expanded={isOpen} ref={btnRef}
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
