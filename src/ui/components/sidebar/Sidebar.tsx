import { msg, t } from '../../../core/i18n';
import { useEngine, useUi } from '../../EngineContext';
import { AddonPanels } from '../addons/AddonPanels';
import { BonePage } from './BonePage';
import { FxPage } from './FxPage';
import { MaterialPage } from './MaterialPage';
import { MorphPage } from './MorphPage';
import { ObjectPage } from './ObjectPage';
import { Outliner } from './Outliner';
import { OutputPage } from './OutputPage';
import { ScenePage } from './ScenePage';

// Blender の N パネルのようなサイドバー。上にアウトライナー (置いた物の一覧)、その下にタブのページ。タブは右端に縦書きで並べる。
// アドオンのパネルは、組み込みのタブの最後か、アドオンが名付けたタブ (組み込みのタブのあと) に出す
export type SideTab = string;
const TABS: [SideTab, string][] = [['object', msg('オブジェクト')], ['material', msg('マテリアル')], ['morph', msg('表情')], ['bone', msg('ボーン')], ['scene', msg('シーン')], ['fx', msg('効果')], ['output', msg('出力')]];

export function Sidebar({ tab, setTab, onLoadPose, onOpenShaderEditor }: { tab: SideTab; setTab: (t: SideTab) => void; onLoadPose: () => void; onOpenShaderEditor: () => void }) {
  const engine = useEngine();
  useUi(s => s.addonsVersion);
  const builtin = new Set(TABS.map(([k]) => k));
  const extra = [...new Set(engine.addons.panels.list().map(p => p.tab).filter(x => !builtin.has(x)))];
  const tabs: [SideTab, string][] = [...TABS, ...extra.map(x => [x, x] as [SideTab, string])];
  // (アドオンを切ってタブがなくなったら、オブジェクトのタブに戻す)
  const shown = tabs.some(([k]) => k === tab) ? tab : 'object';
  return (
    <aside className="sidebar" id="sidebar" aria-label={t('サイドバー')}>
      <div className="side-main">
      <Outliner onPickBone={() => setTab('bone')} />
      <div className="side-content">
        {shown === 'object' && <ObjectPage />}
        {shown === 'material' && <MaterialPage onOpenShaderEditor={onOpenShaderEditor} />}
        {shown === 'morph' && <MorphPage />}
        {shown === 'bone' && <BonePage onLoadPose={onLoadPose} />}
        {shown === 'scene' && <ScenePage />}
        {shown === 'fx' && <FxPage />}
        {shown === 'output' && <OutputPage />}
        {shown !== 'object' && <AddonPanels tab={shown} />}
      </div>
      </div>
      <nav className="side-tabs" role="tablist" aria-label={t('サイドバーのタブ')} aria-orientation="vertical">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={shown === key} onClick={() => setTab(key)}>{t(label)}</button>
        ))}
      </nav>
    </aside>
  );
}
