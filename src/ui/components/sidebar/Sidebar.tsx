import { useEngine, useUi } from '../../EngineContext';
import { AddonPanels } from '../addons/AddonPanels';
import { BonePage } from './BonePage';
import { FxPage } from './FxPage';
import { MaterialPage } from './MaterialPage';
import { MorphPage } from './MorphPage';
import { ObjectPage } from './ObjectPage';
import { OutputPage } from './OutputPage';
import { ScenePage } from './ScenePage';

// Blender の N パネルのようなサイドバー。タブは右端に縦書きで並べる。
// アドオンのパネルは、組み込みのタブの最後か、アドオンが名付けたタブ (組み込みのタブのあと) に出す
export type SideTab = string;
const TABS: [SideTab, string][] = [['object', 'オブジェクト'], ['material', 'マテリアル'], ['morph', '表情'], ['bone', 'ボーン'], ['scene', 'シーン'], ['fx', '効果'], ['output', '出力']];

export function Sidebar({ tab, setTab, onLoadPose, onOpenShaderEditor }: { tab: SideTab; setTab: (t: SideTab) => void; onLoadPose: () => void; onOpenShaderEditor: () => void }) {
  const engine = useEngine();
  useUi(s => s.addonsVersion);
  const builtin = new Set(TABS.map(([k]) => k));
  const extra = [...new Set(engine.addons.panels.list().map(p => p.tab).filter(t => !builtin.has(t)))];
  const tabs: [SideTab, string][] = [...TABS, ...extra.map(t => [t, t] as [SideTab, string])];
  // (アドオンを切ってタブがなくなったら、オブジェクトのタブに戻す)
  const shown = tabs.some(([k]) => k === tab) ? tab : 'object';
  return (
    <aside className="sidebar" id="sidebar" aria-label="サイドバー">
      <div className="side-content">
        {shown === 'object' && <ObjectPage />}
        {shown === 'material' && <MaterialPage onOpenShaderEditor={onOpenShaderEditor} />}
        {shown === 'morph' && <MorphPage />}
        {shown === 'bone' && <BonePage onLoadPose={onLoadPose} />}
        {shown === 'scene' && <ScenePage />}
        {shown === 'fx' && <FxPage />}
        {shown === 'output' && <OutputPage />}
        <AddonPanels tab={shown} />
      </div>
      <nav className="side-tabs" role="tablist" aria-label="サイドバーのタブ" aria-orientation="vertical">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={shown === key} onClick={() => setTab(key)}>{label}</button>
        ))}
      </nav>
    </aside>
  );
}
