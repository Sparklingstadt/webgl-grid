import type { MenuId } from '../../../engine/extend/Registry';
import { useEngine, useUi } from '../../EngineContext';
import { MenuItem, MenuSep } from '../Menu';

// --- アドオンが足したメニューの項目 (メニューの最後に、区切り線のあとに並べる) ---
export function AddonMenuItems({ menu }: { menu: MenuId }) {
  const engine = useEngine();
  useUi(s => s.extVersion);
  useUi(s => s.sel);
  const items = engine.ext.menus.list().filter(m => m.menu === menu);
  if (!items.length) return null;
  return (
    <>
      <MenuSep />
      {items.map(m => <MenuItem key={m.key} label={m.label} disabled={m.enabled ? !m.enabled() : false} onSelect={() => m.run()} />)}
    </>
  );
}
