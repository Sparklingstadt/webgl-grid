import { BonePage } from './BonePage';
import { FxPage } from './FxPage';
import { MaterialPage } from './MaterialPage';
import { MorphPage } from './MorphPage';
import { ObjectPage } from './ObjectPage';

// Blender の N パネルのようなサイドバー。タブは右端に縦書きで並べる
export type SideTab = 'object' | 'material' | 'morph' | 'bone' | 'fx';
const TABS: [SideTab, string][] = [['object', 'オブジェクト'], ['material', 'マテリアル'], ['morph', '表情'], ['bone', 'ボーン'], ['fx', '効果']];

export function Sidebar({ tab, setTab, onLoadPose, onOpenShaderEditor }: { tab: SideTab; setTab: (t: SideTab) => void; onLoadPose: () => void; onOpenShaderEditor: () => void }) {
  return (
    <aside className="sidebar" id="sidebar" aria-label="サイドバー">
      <div className="side-content">
        {tab === 'object' && <ObjectPage />}
        {tab === 'material' && <MaterialPage onOpenShaderEditor={onOpenShaderEditor} />}
        {tab === 'morph' && <MorphPage />}
        {tab === 'bone' && <BonePage onLoadPose={onLoadPose} />}
        {tab === 'fx' && <FxPage />}
      </div>
      <nav className="side-tabs" role="tablist" aria-label="サイドバーのタブ" aria-orientation="vertical">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>
        ))}
      </nav>
    </aside>
  );
}
