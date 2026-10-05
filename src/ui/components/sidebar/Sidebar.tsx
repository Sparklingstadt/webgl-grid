import { useRef, useState } from 'react';
import { msg, t } from '../../../core/i18n';
import type { SelInfo } from '../../../engine';
import { useEngine, useUi } from '../../EngineContext';
import { AddonPanels } from '../addons/AddonPanels';
import { Icon, type IconName } from '../icons';
import { BonePage } from './BonePage';
import { CameraPage } from './CameraPage';
import { FxPage } from './FxPage';
import { LightPage } from './LightPanel';
import { MaterialPage } from './MaterialPage';
import { MmeValuesPage } from './MmeValuesPage';
import { ModifierPage } from './ModifierPage';
import { MorphPage } from './MorphPage';
import { ObjectPage } from './ObjectPage';
import { Outliner } from './Outliner';
import { OutputPage } from './OutputPage';
import { PhysicsPage } from './PhysicsPage';
import { ScenePage } from './ScenePage';

// --- 右の列 (Blender の右側): 上にアウトライナー、下にプロパティエディター。あいだの境目で高さを変える ---
// プロパティのタブは、Blender と同じく左端に縦に並べたアイコン。場面全体のタブ (レンダー・出力・シーン) と、
// 選んでいる物のタブ (オブジェクト・モディファイアー・物理演算・データ・マテリアル) に分け、物に使えないタブは出さない。
// アドオンのパネルは、組み込みのタブの最後か、アドオンが名付けたタブ (組み込みのタブのあと) に出す
export type SideTab = string;
// when: 出すか (sel: 選んでいる物、mme: レンダーエンジンが MME 互換か)
interface TabDef { key: SideTab; label: string; icon: IconName; group: 'scene' | 'object'; when?: (sel: SelInfo | null, mme: boolean) => boolean }
const isModel = (s: SelInfo | null) => s?.kind === 'model';
const TABS: TabDef[] = [
  { key: 'fx', label: msg('効果'), icon: 'render', group: 'scene' },
  { key: 'output', label: msg('出力'), icon: 'output', group: 'scene' },
  { key: 'scene', label: msg('シーン'), icon: 'world', group: 'scene' },
  { key: 'object', label: msg('オブジェクト'), icon: 'object', group: 'object' },
  { key: 'modifier', label: msg('モディファイアー'), icon: 'modifier', group: 'object', when: s => !!s && (s.kind === 'shape' || s.kind === 'model') },
  { key: 'physics', label: msg('物理演算'), icon: 'physics', group: 'object', when: isModel },
  { key: 'morph', label: msg('表情'), icon: 'shapekey', group: 'object', when: isModel },
  { key: 'bone', label: msg('ボーン'), icon: 'bone', group: 'object', when: isModel },
  { key: 'light', label: msg('ライト'), icon: 'light', group: 'object', when: s => s?.kind === 'light' },
  { key: 'cameradata', label: msg('カメラ'), icon: 'cameraData', group: 'object', when: s => s?.kind === 'camera' },
  { key: 'material', label: msg('マテリアル'), icon: 'material', group: 'object', when: s => !!s && (s.kind === 'shape' || s.kind === 'model') },
  // (MME の値: MME の物 (コントローラー・アクセサリ) の値と、当てた .fx のパラメータ。モデルはパラメータだけなので、MME 互換のときだけ)
  { key: 'mme', label: msg('MME'), icon: 'mme', group: 'object', when: (s, mme) => s?.kind === 'mme' || (mme && s?.kind === 'model') },
];
const SIZE_KEY = 'webgl-grid.sidebar';
const loadSize = () => { try { return Number(JSON.parse(localStorage.getItem(SIZE_KEY) ?? '{}').outliner) || 0; } catch { return 0; } };
const saveSize = (outliner: number) => { try { localStorage.setItem(SIZE_KEY, JSON.stringify({ outliner })); } catch { /* (保存できなくても使える) */ } };

export function Sidebar({ tab, setTab, onLoadPose, onOpenShaderEditor, onHover }: {
  tab: SideTab; setTab: (t: SideTab) => void; onLoadPose: () => void; onOpenShaderEditor: () => void; onHover?: (area: 'outliner' | 'props') => void;
}) {
  const engine = useEngine();
  const sel = useUi(s => s.sel);
  const mme = useUi(s => s.mme.settings.engine === 'mme');
  useUi(s => s.addonsVersion);
  const builtin = new Set(TABS.map(d => d.key));
  const extra = [...new Set(engine.addons.panels.list().map(p => p.tab).filter(x => !builtin.has(x)))];
  const tabs: TabDef[] = [...TABS.filter(d => d.when?.(sel, mme) ?? true), ...extra.map(x => ({ key: x, label: x, icon: 'addon' as IconName, group: 'object' as const }))];
  // 選んでいる物に使えないタブ (と、切ったアドオンのタブ) のときは、オブジェクトのタブを見せる (選び直すと戻る)
  const shown = tabs.some(d => d.key === tab) ? tab : 'object';
  const current = tabs.find(d => d.key === shown)!;
  // アウトライナーの高さ (境目をドラッグ)
  const [olH, setOlH] = useState(() => loadSize() || 180);
  const col = useRef<HTMLElement>(null);
  const resize = (e: React.PointerEvent) => {
    const y0 = e.clientY, h0 = olH, max = (col.current?.clientHeight ?? 600) - 120;
    let h = h0;
    const move = (ev: PointerEvent) => { h = Math.min(Math.max(h0 + ev.clientY - y0, 60), max); setOlH(h); };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); saveSize(h); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };
  return (
    <aside className="sidebar" id="side-column" aria-label={t('アウトライナーとプロパティ')} ref={col}>
      <Outliner onPickBone={() => setTab('bone')} style={{ height: olH }} onHover={() => onHover?.('outliner')} />
      <div className="area-resizer horizontal" role="separator" aria-orientation="horizontal" aria-label={t('アウトライナーの高さ')} onPointerDown={resize} />
      <section className="area props" aria-label={t('プロパティ')} onPointerEnter={() => onHover?.('props')}>
        <div className="area-header">
          <Icon name="properties" className="editor-type" />
          <span className="props-path">
            {/* (場面のタブと、何も選んでいないときは「シーン」) */}
            <Icon name={current.group === 'scene' || !sel ? 'world' : 'object'} />
            {current.group === 'scene' || !sel ? t('シーン') : t(sel.name)}
            <span className="props-sep">›</span>{t(current.label)}
          </span>
        </div>
        <div className="props-body">
          <nav className="side-tabs" role="tablist" aria-label={t('プロパティのタブ')} aria-orientation="vertical">
            {tabs.map((d, i) => (
              <button key={d.key} type="button" role="tab" aria-selected={shown === d.key} aria-label={t(d.label)} title={t(d.label)}
                      className={i > 0 && tabs[i - 1].group !== d.group ? 'group-start' : undefined} onClick={() => setTab(d.key)}>
                <Icon name={d.icon} />
              </button>
            ))}
          </nav>
          <div className="side-content">
            {shown === 'object' && <ObjectPage />}
            {shown === 'modifier' && <ModifierPage />}
            {shown === 'physics' && <PhysicsPage />}
            {shown === 'light' && <LightPage />}
            {shown === 'cameradata' && <CameraPage />}
            {shown === 'material' && <MaterialPage onOpenShaderEditor={onOpenShaderEditor} />}
            {shown === 'morph' && <MorphPage />}
            {shown === 'bone' && <BonePage onLoadPose={onLoadPose} />}
            {shown === 'scene' && <ScenePage />}
            {shown === 'mme' && <MmeValuesPage />}
            {shown === 'fx' && <FxPage onShowValues={() => setTab('mme')} />}
            {shown === 'output' && <OutputPage />}
            {!['object', 'modifier', 'physics', 'light', 'cameradata'].includes(shown) && <AddonPanels tab={shown} />}
          </div>
        </div>
      </section>
    </aside>
  );
}
