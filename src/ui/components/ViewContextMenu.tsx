import { useState } from 'react';
import { t } from '../../core/i18n';
import { useEngine, useUi } from '../EngineContext';
import { Popover } from './controls/Popover';
import { MenuItem, MenuLabel, MenuSep } from './Menu';
import { requestRename } from './sidebar/Outliner';

// --- ビューポートの右クリックのメニュー (Blender のオブジェクトのコンテキストメニュー) ---
// 選んでいる物の移動・回転・拡大縮小・複製・削除・隠す・名前、選択の操作
export function ViewContextMenu({ showSide }: { showSide: () => void }) {
  const engine = useEngine();
  const at = useUi(s => s.contextMenu);
  const sel = useUi(s => s.sel);
  const selIds = useUi(s => s.selIds);
  const canAdd = useUi(s => s.canAdd);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!at) return null;
  const close = () => engine.ui.set({ contextMenu: null });
  const any = selIds.length > 0;
  const run = (fn: () => void) => () => { close(); fn(); };
  return (
    <>
      <div className="ctx-anchor" style={{ left: at.x, top: at.y }} ref={setAnchor} />
      {anchor && (
        <Popover anchor={anchor} onClose={close} className="menu-pop" role="menu" label={t('オブジェクトのメニュー')}>
          <MenuLabel>{any ? (selIds.length > 1 ? t('{n} 個のオブジェクト', { n: selIds.length }) : t(sel?.name ?? '')) : t('オブジェクト')}</MenuLabel>
          <MenuItem label={t('移動')} kbd="G" disabled={!any} onSelect={run(() => engine.transform.start('grab'))} />
          <MenuItem label={t('回転')} kbd="R" disabled={!any} onSelect={run(() => engine.transform.start('rotate'))} />
          <MenuItem label={t('拡大縮小')} kbd="S" disabled={!any} onSelect={run(() => engine.transform.start('scale'))} />
          <MenuSep />
          <MenuItem label={t('複製')} kbd="Shift D" disabled={!any || !canAdd} onSelect={run(() => void engine.duplicateSelected())} />
          <MenuItem label={t('名前を変更')} kbd="F2" disabled={!sel} onSelect={run(() => { showSide(); requestRename(); })} />
          <MenuItem label={t('選択物を隠す')} kbd="H" disabled={!any} onSelect={run(() => engine.hideSelected())} />
          <MenuItem label={t('削除')} kbd="X" disabled={!any} onSelect={run(() => engine.deleteSelected())} />
          <MenuSep />
          <MenuItem label={t('すべて選択')} kbd="A" onSelect={run(() => engine.selectAll())} />
          <MenuItem label={t('選択を反転')} kbd="Ctrl I" onSelect={run(() => engine.invertSelection())} />
          <MenuItem label={t('すべて表示')} kbd="Alt H" onSelect={run(() => engine.revealAll())} />
        </Popover>
      )}
    </>
  );
}
