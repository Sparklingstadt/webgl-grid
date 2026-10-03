import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { t } from '../../../core/i18n';
import type { Engine } from '../../../engine';
import { isModel, kindOf, type ModelObj, type Obj, type ObjKind } from '../../../engine/types';
import { kindName, nameOf } from '../../../engine/world/Selection';
import { useEngine, useUi } from '../../EngineContext';
import { Popover } from '../controls/Popover';
import { Icon as EditorIcon } from '../icons';
import { MenuItem, MenuSep } from '../Menu';

// --- アウトライナー (Blender のアウトライナー): 場面に置いた物を一覧にして、選ぶ・名前を変える・隠す・消す ---
// クリックで選ぶ、ダブルクリック (F2) で名前を変える、目のアイコンでビューポートで隠す、カメラのアイコンでレンダリングに写さない、
// 右クリックでメニュー。MMD モデルは広げるとボーンが並び、押すとそのボーンを選んでボーンのタブを開く。
// ドラッグで並べ替える (マウスは行のどこでも、指は種類のアイコンをつかんで。Esc でやめる)。
// キーボード: ↑↓ で選ぶ物を変える、Alt+↑↓ で並べ替える、→← で広げる・閉じる、H / Shift+H / Alt+H で隠す・見せる、X で消す
const ICON: Record<ObjKind | 'bone', ReactNode> = {
  shape: <path d="M8 1.5 13.5 4.5v7L8 14.5 2.5 11.5v-7z M8 1.5v6.5 M2.5 4.5 8 8l5.5-3.5" />,
  model: <><circle cx="8" cy="4" r="2.2" /><path d="M3.5 14.5c0-3.5 2-5.5 4.5-5.5s4.5 2 4.5 5.5" /></>,
  light: <><path d="M5.5 9.5a4 4 0 1 1 5 0c-.6.5-.9 1.2-.9 2h-3.2c0-.8-.3-1.5-.9-2z" /><path d="M6.5 14h3" /></>,
  bone: <path d="M8 2 11 6 8 14 5 6z M5 6h6" />,
};
const Icon = ({ kind }: { kind: ObjKind | 'bone' }) => (
  <svg className={`ol-icon ol-${kind}`} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">{ICON[kind]}</svg>
);
const Eye = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
    {off ? <path d="M2 8c1.5 2 3.6 3.2 6 3.2S12.5 10 14 8 M4 10.5 3 12 M8 11.2V13 M12 10.5l1 1.5" />
      : <><path d="M1.5 8C3 5.3 5.3 3.8 8 3.8S13 5.3 14.5 8C13 10.7 10.7 12.2 8 12.2S3 10.7 1.5 8z" /><circle cx="8" cy="8" r="2" /></>}
  </svg>
);
const Camera = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
    <path d="M2 5h8v7H2z M10 7.5 14 5v7l-4-2.5" />{off && <path d="M1.5 14 14.5 2" strokeLinecap="round" />}
  </svg>
);

// F2 (どこからでも): 選んでいる物の名前を変える。サイドバーを閉じていたときは、開いたアウトライナーが受け取る
let renameRequested = false;
export function requestRename() { renameRequested = true; dispatchEvent(new Event('outliner-rename')); }

// ドラッグで指している所: 行 (上の段の物) の上半分なら前、下半分なら後ろ。一覧の外なら、いちばん近い行
interface Drop { target: number; where: 'before' | 'after' }
function dropAt(rows: Map<number, HTMLElement>, y: number): Drop | null {
  let best: Drop | null = null, dist = Infinity;
  for (const [id, li] of rows) {
    const r = (li.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
    if (!r) continue;
    const mid = (r.top + r.bottom) / 2, d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < dist) { dist = d; best = { target: id, where: y < mid ? 'before' : 'after' }; }
  }
  return best;
}

// ボーンの並び: ボーンのタブに出るもの (動かせるもの) を、.pmx の順に、親子の深さを付けて
interface BoneNode { name: string; parent: BoneNode | null; isBone?: boolean }
function bonesOf(engine: Engine, o: ModelObj) {
  const bones: BoneNode[] = o.model.skeleton.bones;
  const ok = new Set(engine.posing.boneGroups(o).flatMap(g => g.bones.map(b => b.index)));
  const shown = new Set([...ok].map(i => bones[i]));
  const depth = (b: BoneNode) => { let d = 0; for (let p = b.parent; p?.isBone; p = p.parent) if (shown.has(p)) d++; return d; };
  return bones.flatMap((b, i) => (ok.has(i) ? [{ i, name: b.name, depth: Math.min(depth(b), 12) }] : []));
}

export function Outliner({ onPickBone, style, onHover }: { onPickBone: () => void; style?: CSSProperties; onHover?: () => void }) {
  const engine = useEngine();
  const sel = useUi(s => s.sel);
  useUi(s => s.sceneVersion);
  useUi(s => s.values); // (選んでいるボーン)
  useUi(s => s.lang);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [renaming, setRenaming] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ id: number; anchor: HTMLElement } | null>(null);
  const rows = useRef(new Map<number, HTMLElement>());
  const tree = useRef<HTMLUListElement>(null);
  const [drag, setDrag] = useState<Drop & { id: number } | null>(null);
  const dragged = useRef(false); // (ドラッグを終えたときのクリックでは選ばない)
  const objects = engine.world.objects;
  const q = filter.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  // 絞り込み: 名前か、ボーンの名前が合う物
  const shown = objects.map(o => {
    const bones = isModel(o) && (expanded.has(o.id) || q) ? bonesOf(engine, o).filter(b => match(b.name) || match(nameOf(o))) : [];
    return { o, bones, hit: match(nameOf(o)) || bones.length > 0 };
  }).filter(x => x.hit);

  // ビューポートで選んだ物を見える所に出す
  const selId = sel?.id;
  useEffect(() => { if (selId !== undefined) rows.current.get(selId)?.scrollIntoView?.({ block: 'nearest' }); }, [selId]);
  useEffect(() => {
    const onRename = () => {
      renameRequested = false;
      const id = engine.selection.current?.id;
      if (id !== undefined) setRenaming(id);
    };
    if (renameRequested) onRename();
    addEventListener('outliner-rename', onRename);
    return () => removeEventListener('outliner-rename', onRename);
  }, [engine]);

  const toggle = (id: number, on = !expanded.has(id)) => setExpanded(prev => { const s = new Set(prev); if (on) s.add(id); else s.delete(id); return s; });
  const select = (o: Obj) => { engine.select(o); rows.current.get(o.id)?.focus(); };
  const move = (o: Obj, target: Obj, where: Drop['where']) => {
    engine.moveObject(o, target, where);
    requestAnimationFrame(() => rows.current.get(o.id)?.focus()); // (並べ直した行に、フォーカスを戻す)
  };
  // ドラッグ: 4px 動いたら始め、指している行の上半分なら前、下半分なら後ろに入れる。一覧の端では送る
  const startDrag = (e: ReactPointerEvent, o: Obj) => {
    const el = e.target as HTMLElement;
    if (e.button !== 0 || renaming !== null || el.closest('button, input')) return;
    if (e.pointerType === 'touch' && !el.closest('.ol-icon')) return; // (指は、行のほかの所ではスクロール)
    const x0 = e.clientX, y0 = e.clientY;
    let last: Drop | null = null;
    const onMove = (ev: PointerEvent) => {
      if (!last && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      ev.preventDefault();
      const box = tree.current?.getBoundingClientRect();
      if (box && ev.clientY < box.top + 16) tree.current!.scrollTop -= 8;
      else if (box && ev.clientY > box.bottom - 16) tree.current!.scrollTop += 8;
      last = dropAt(rows.current, ev.clientY) ?? last ?? { target: o.id, where: 'before' };
      setDrag({ id: o.id, ...last });
    };
    const end = (apply: boolean) => {
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onCancel);
      removeEventListener('keydown', onEsc, true);
      setDrag(null);
      if (!last) return;
      dragged.current = true;
      setTimeout(() => { dragged.current = false; });
      const target = engine.world.find(last.target);
      if (apply && target) move(o, target, last.where);
    };
    const onUp = () => end(true), onCancel = () => end(false);
    const onEsc = (ev: globalThis.KeyboardEvent) => { if (ev.key === 'Escape' && last) { ev.stopPropagation(); end(false); } };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onCancel);
    addEventListener('keydown', onEsc, true);
  };
  const pickBone = (o: ModelObj, i: number) => { engine.select(o); engine.setBoneSel(i); onPickBone(); };
  const onKey = (e: KeyboardEvent, o: Obj) => {
    const list = shown.map(x => x.o), at = list.indexOf(o);
    const go = (i: number) => { const next = list[Math.min(Math.max(i, 0), list.length - 1)]; if (next) select(next); };
    let used = true;
    switch (e.key) {
      case 'ArrowDown': if (e.altKey) { if (list[at + 1]) move(o, list[at + 1], 'after'); } else go(at + 1); break;
      case 'ArrowUp': if (e.altKey) { if (list[at - 1]) move(o, list[at - 1], 'before'); } else go(at - 1); break;
      case 'Home': go(0); break;
      case 'End': go(list.length - 1); break;
      case 'ArrowRight': if (isModel(o)) toggle(o.id, true); break;
      case 'ArrowLeft': if (isModel(o)) toggle(o.id, false); break;
      case 'F2': setRenaming(o.id); break;
      case 'Enter': engine.select(o); break;
      default: used = false;
    }
    if (used) { e.preventDefault(); e.stopPropagation(); }
  };
  const menuObj = menu ? engine.world.find(menu.id) : null;

  return (
    <section className="area outliner" aria-label={t('アウトライナー')} style={style} onPointerEnter={onHover}>
      <div className="area-header">
        <EditorIcon name="outliner" className="editor-type" />
        <input type="search" className="ol-filter" placeholder={t('絞り込み')} aria-label={t('アウトライナーを絞り込む')} value={filter} onChange={e => setFilter(e.target.value)} />
      </div>
      <ul className={`ol-tree${drag ? ' dragging' : ''}`} role="tree" aria-label={t('シーンの物')} ref={tree}>
        {!shown.length && <li className="ol-empty" role="none">{objects.length ? t('合う物がありません') : t('何も置いていません')}</li>}
        {shown.map(({ o, bones }) => {
          const name = nameOf(o), active = sel?.id === o.id, model = isModel(o);
          const isOpen = model && (expanded.has(o.id) || (!!q && bones.length > 0));
          return (
            <li key={o.id} role="treeitem" aria-level={1} aria-selected={active} aria-expanded={model ? isOpen : undefined} aria-label={name}
                tabIndex={active || (!sel && o === shown[0].o) ? 0 : -1} ref={el => { if (el) rows.current.set(o.id, el); else rows.current.delete(o.id); }}
                onKeyDown={e => { if (e.target === e.currentTarget) onKey(e, o); }}>
              <div className={`ol-row${active ? ' active' : ''}${o.hidden ? ' hidden' : ''}${drag?.id === o.id ? ' drag-source' : ''}${drag && drag.target === o.id && drag.id !== o.id ? ` drop-${drag.where}` : ''}`}
                   onPointerDown={e => startDrag(e, o)}
                   onClick={() => { if (!dragged.current) select(o); }} onDoubleClick={() => setRenaming(o.id)}
                   onContextMenu={e => { e.preventDefault(); select(o); setMenu({ id: o.id, anchor: e.currentTarget }); }}>
                {model
                  ? <button type="button" className="ol-twist" tabIndex={-1} aria-label={isOpen ? t('ボーンを閉じる') : t('ボーンを開く')} aria-expanded={isOpen}
                            onClick={e => { e.stopPropagation(); toggle(o.id); }} />
                  : <span className="ol-twist" />}
                <Icon kind={kindOf(o)} />
                {renaming === o.id
                  ? <RenameField obj={o} onDone={() => { setRenaming(null); rows.current.get(o.id)?.focus(); }} />
                  : <span className="ol-name" title={name}>{name}</span>}
                <button type="button" className="ol-toggle" tabIndex={-1} aria-label={t('ビューポートで隠す')} title={t('ビューポートで隠す (H)。レンダリングには写ります')}
                        aria-pressed={!!o.hidden} onClick={e => { e.stopPropagation(); engine.setVisibility(o, { hidden: !o.hidden }); }}><Eye off={!!o.hidden} /></button>
                <button type="button" className="ol-toggle" tabIndex={-1} aria-label={t('レンダリングに写さない')} title={t('レンダリングに写さない')}
                        aria-pressed={!!o.hideRender} onClick={e => { e.stopPropagation(); engine.setVisibility(o, { hideRender: !o.hideRender }); }}><Camera off={!!o.hideRender} /></button>
              </div>
              {isOpen && model && (
                <ul role="group">
                  {bones.map(b => (
                    <li key={b.i} role="treeitem" aria-level={2} aria-selected={active && o.boneSel === b.i} aria-label={b.name} tabIndex={-1}
                        className={`ol-row ol-bone${active && o.boneSel === b.i ? ' active' : ''}`} style={{ paddingLeft: 28 + b.depth * 8 }}
                        onClick={() => pickBone(o, b.i)} onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); pickBone(o, b.i); } }}>
                      <Icon kind="bone" /><span className="ol-name" title={b.name}>{b.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {menu && menuObj && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} className="menu-pop" role="menu" label={t('アウトライナーのメニュー')}>
          <div onClick={e => { if ((e.target as HTMLElement).closest('button:not(:disabled)')) setMenu(null); }}>
            <MenuItem label={t('名前を変更')} kbd="F2" onSelect={() => setRenaming(menuObj.id)} />
            <MenuSep />
            <MenuItem label={menuObj.hidden ? t('ビューポートで表示') : t('ビューポートで隠す')} kbd="H" onSelect={() => engine.setVisibility(menuObj, { hidden: !menuObj.hidden })} />
            <MenuItem label={t('ほかを隠す')} kbd="Shift+H" onSelect={() => { engine.select(menuObj); engine.hideSelected(true); }} />
            <MenuItem label={t('すべて表示')} kbd="Alt+H" onSelect={() => engine.revealAll()} />
            <MenuItem label={menuObj.hideRender ? t('レンダリングに写す') : t('レンダリングに写さない')} onSelect={() => engine.setVisibility(menuObj, { hideRender: !menuObj.hideRender })} />
            <MenuSep />
            <MenuItem label={t('削除')} kbd="X" onSelect={() => engine.world.remove(menuObj)} />
          </div>
        </Popover>
      )}
    </section>
  );
}

// 名前の欄: Enter・外を押すと決める、Esc でやめる。空にするか種類の名前にすると、種類の名前に戻す
function RenameField({ obj, onDone }: { obj: Obj; onDone: () => void }) {
  const engine = useEngine();
  const cancelled = useRef(false);
  const commit = (v: string) => {
    if (!cancelled.current) engine.renameObj(obj, v.trim() === kindName(obj) ? null : v);
    onDone();
  };
  return (
    <input className="ol-rename" aria-label={t('名前')} defaultValue={nameOf(obj)} autoFocus maxLength={64}
           onFocus={e => e.currentTarget.select()} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
           onBlur={e => commit(e.currentTarget.value)}
           onKeyDown={e => {
             e.stopPropagation();
             if (e.key === 'Enter') e.currentTarget.blur();
             else if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); }
           }} />
  );
}
