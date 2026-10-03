import { useState } from 'react';
import { msg, t } from '../../core/i18n';
import type { BoneValue } from '../../core/types';
import { useEngine, useUi } from '../EngineContext';
import { BSlider } from './BSlider';
import { BCheck } from './controls/BCheck';
import { NumField } from './NumField';
import { useShowFrame } from './OutputFrame';
import { Empty, Panel } from './sidebar/Panel';

// --- ビューポートのサイドバー (Blender の N パネル): ビューポートの右に重ねて出し、N で出す・隠す ---
// タブは右端に縦書き: アイテム (選んでいる物の位置と向き。ポーズモードでは選んでいるボーン)・ツール (いまの操作)・ビュー (視点・表示)
type NTab = 'item' | 'tool' | 'view';
const TABS: [NTab, string][] = [['item', msg('アイテム')], ['tool', msg('ツール')], ['view', msg('ビュー')]];
const TAB_KEY = 'webgl-grid.npanel';

export function NPanel() {
  const [tab, setTab] = useState<NTab>(() => { try { return (localStorage.getItem(TAB_KEY) as NTab | null) ?? 'item'; } catch { return 'item'; } });
  const choose = (k: NTab) => { setTab(k); try { localStorage.setItem(TAB_KEY, k); } catch { /* (覚えられなくても使える) */ } };
  return (
    <aside className="npanel" id="n-panel" aria-label={t('サイドバー')} onPointerDown={e => e.stopPropagation()}>
      <div className="npanel-content">
        {tab === 'item' && <ItemTab />}
        {tab === 'tool' && <ToolTab />}
        {tab === 'view' && <ViewTab />}
      </div>
      <nav className="npanel-tabs" role="tablist" aria-label={t('サイドバーのタブ (N)')} aria-orientation="vertical">
        {TABS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => choose(k)}>{t(label)}</button>)}
      </nav>
    </aside>
  );
}

const ROT: [keyof BoneValue, string][] = [['rx', msg('回転 X')], ['ry', msg('回転 Y')], ['rz', msg('回転 Z')]];

// アイテム: 選んでいる物のトランスフォーム。ポーズモードでは、選んでいるボーンの回転
function ItemTab() {
  const engine = useEngine();
  const sel = useUi(s => s.sel);
  const poseMode = useUi(s => s.poseMode);
  useUi(s => s.values);
  if (!sel) return <Panel title={t('トランスフォーム')}><Empty>{t('何も選んでいません。')}</Empty></Panel>;
  const bone = poseMode ? engine.boneSel() : undefined;
  if (bone !== undefined) {
    const v = engine.boneValue(bone)!;
    const name = engine.boneGroups().flatMap(g => g.bones).find(b => b.index === bone)?.name ?? '';
    return (
      <Panel title={t('ボーン: {name}', { name })}>
        {ROT.map(([k, label]) => (
          <BSlider key={k} label={t(label)} value={v[k]} min={-180} max={180} step={1} digits={0} unit="°" onChange={x => engine.setBone(bone, k, x)} />
        ))}
      </Panel>
    );
  }
  const deg = ((sel.r * 180 / Math.PI) % 360 + 540) % 360 - 180;
  return (
    <Panel title={t('トランスフォーム')}>
      <div className="npanel-name">{t(sel.name)}</div>
      <div className="prop">
        <label htmlFor="np-x">{t('位置 X')}</label><NumField id="np-x" label={t('位置 X (サイドバー)')} value={+sel.x.toFixed(2)} digits={2} step={0.1} onCommit={v => engine.setObjProp('x', v)} />
        <label>{t('位置 Y')}</label><span className="note">{sel.y.toFixed(2)}</span>
        <label htmlFor="np-z">{t('位置 Z')}</label><NumField id="np-z" label={t('位置 Z (サイドバー)')} value={+sel.z.toFixed(2)} digits={2} step={0.1} onCommit={v => engine.setObjProp('z', v)} />
        <label htmlFor="np-r">{t('回転')}</label><NumField id="np-r" label={t('回転 (サイドバー)')} value={Math.round(deg)} onCommit={v => engine.setObjProp('r', v)} />
      </div>
    </Panel>
  );
}

// ツール: いまの操作 (カメラの回転・移動。ポーズモードではボーンを回す・動かす)
function ToolTab() {
  const engine = useEngine();
  const mode = useUi(s => s.mode);
  const poseMode = useUi(s => s.poseMode);
  const poseTool = useUi(s => s.poseTool);
  return (
    <Panel title={t('アクティブツール')}>
      {poseMode ? <>
        <BCheck checked={poseTool === 'rotate'} onChange={() => engine.pose.setTool('rotate')}>{t('ボーンを回す (R)')}</BCheck>
        <BCheck checked={poseTool === 'translate'} onChange={() => engine.pose.setTool('translate')}>{t('ボーンを動かす (G)')}</BCheck>
      </> : <>
        <BCheck checked={mode === 'orbit'} onChange={() => engine.camera.setMode('orbit')}>{t('回転: ドラッグで注視点のまわりを回る')}</BCheck>
        <BCheck checked={mode === 'pan'} onChange={() => engine.camera.setMode('pan')}>{t('移動: ドラッグで地面に沿って動く')}</BCheck>
      </>}
    </Panel>
  );
}

// ビュー: 視野角・視点・出力の範囲
function ViewTab() {
  const engine = useEngine();
  const { camera } = engine;
  const [, redraw] = useState(0);
  const [showFrame, setShowFrame] = useShowFrame();
  return (
    <>
      <Panel title={t('ビュー')}>
        <BSlider label={t('視野角')} value={camera.cam.fov} min={10} max={120} step={1} digits={0} unit="°"
                 onChange={v => { camera.setFov(v); redraw(n => n + 1); }} />
        <BCheck checked={showFrame} onChange={setShowFrame}>{t('出力の範囲を表示')}</BCheck>
      </Panel>
      <Panel title={t('視点')}>
        <div className="row">
          <button type="button" className="bbtn" onClick={() => camera.snapView('front')}>{t('前')}</button>
          <button type="button" className="bbtn" onClick={() => camera.snapView('right')}>{t('右')}</button>
          <button type="button" className="bbtn" onClick={() => camera.snapView('top')}>{t('上')}</button>
        </div>
        <button type="button" className="bbtn" onClick={() => camera.resetView()}>{t('視点を戻す (Home)')}</button>
      </Panel>
    </>
  );
}
