import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../../core/i18n';
import { LIGHT_TYPES } from '../../core/light';
import { SHAPES } from '../../core/shapes';
import { useEngine, useUi } from '../EngineContext';
import { AddonMenuItems } from './addons/AddonMenuItems';
import { BSelect } from './controls/BSelect';
import { Gizmo } from './Gizmo';
import { ObjGizmo } from './ObjGizmo';
import { Menu, MenuItem, MenuLabel, MenuSep } from './Menu';
import type { SideTab } from './sidebar/Sidebar';
import { Icon } from './icons';
import { NPanel } from './NPanel';
import { CollectionMenu, SHADING_LABELS, ShadingMenu, ViewContextMenu } from './ViewContextMenu';
import type { ShadingMode } from '../../engine/render/Viewport';
import { OutputFrame, RegionSelect, useShowFrame } from './OutputFrame';
import { ModelPicker } from './ModelPicker';
import { RecoverBanner } from './Overlays';
import { requestRename } from './sidebar/Outliner';

// 3D ビューポート (Blender の 3D ビューポート): 見出し (エディターの種類・モード・ビュー・追加・オブジェクトのメニュー)、
// 左のツールバー、左上の文字、右上のナビゲーションギズモ
export function ViewportArea(props: {
  sideOpen: boolean; toggleSide: () => void; nOpen: boolean; toggleN: () => void; toolsOpen: boolean; toggleTools: () => void; maximized: boolean; toggleMax: () => void; tlOpen: boolean; toggleTl: () => void;
  onOpenFiles: () => void; onViewportPointerDown: () => void; showTab: (tab: SideTab) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const engine = useEngine();
  const { camera } = engine;
  const mode = useUi(s => s.mode);
  const poseMode = useUi(s => s.poseMode);
  const poseTool = useUi(s => s.poseTool);
  const canAdd = useUi(s => s.canAdd);
  const sel = useUi(s => s.sel);
  const viewInfo = useUi(s => s.viewInfo);
  const selIds = useUi(s => s.selIds);
  const boxSelect = useUi(s => s.boxSelect);
  const box = useUi(s => s.box);
  const transform = useUi(s => s.transform);
  const snap = useUi(s => s.snap);
  const shading = useUi(s => s.shading);
  useUi(s => s.sceneVersion);
  const empty = !engine.world.objects.length && !engine.stage.model; // 何も置いていない (始めたとき・最初の状態に戻したとき)
  const [showFrame, setShowFrame] = useShowFrame();
  const [viewportEl, setViewportEl] = useState<HTMLDivElement | null>(null);
  // canvas ができたら描き始め、なくなるときに片付ける
  useEffect(() => {
    engine.mount(canvasRef.current!, viewportRef.current!);
    return () => engine.unmount();
  }, [engine]);

  return (
    <section className="area" aria-label={t('3D ビューポート')}>
      <div className="area-header">
        <Icon name="view3d" className="editor-type" />
        <BSelect<'object' | 'pose'> label={t('モード')} className="mode-select" value={poseMode ? 'pose' : 'object'}
                                    onChange={v => engine.pose.setActive(v === 'pose')}
                                    options={[{ value: 'object', label: t('オブジェクトモード') }, { value: 'pose', label: t('ポーズモード'), disabled: sel?.kind !== 'model' }]} />
        <Menu id="view" label={t('ビュー')}>
          <MenuItem label={t('前から見る')} kbd={t('テンキー 1')} onSelect={() => camera.snapView('front')} />
          <MenuItem label={t('右から見る')} kbd={t('テンキー 3')} onSelect={() => camera.snapView('right')} />
          <MenuItem label={t('上から見る')} kbd={t('テンキー 7')} onSelect={() => camera.snapView('top')} />
          <MenuItem label={t('視点を戻す')} kbd="Home" onSelect={() => camera.resetView()} />
          <MenuItem label={t('場面のカメラから見る')} kbd={t('テンキー 0')} onSelect={() => engine.toggleCameraView()} />
          <MenuSep />
          <MenuItem label={`${snap ? '✓ ' : ''}${t('スナップ')}`} kbd="Shift Tab" onSelect={() => engine.transform.setSnap(!snap)} />
          <MenuSep />
          <MenuLabel>{t('ビューポートの表示 (Z)')}</MenuLabel>
          {(Object.keys(SHADING_ICONS) as ShadingMode[]).map(m => (
            <MenuItem key={m} label={`${shading === m ? '✓ ' : ''}${t(SHADING_LABELS[m])}`} kbd={m === 'wireframe' ? 'Shift Z' : undefined} onSelect={() => engine.shading.set(m)} />
          ))}
          <MenuSep />
          <MenuItem label={props.toolsOpen ? t('ツールバーを隠す') : t('ツールバーを出す')} kbd="T" onSelect={props.toggleTools} />
          <MenuItem label={props.nOpen ? t('サイドバーを隠す') : t('サイドバーを出す')} kbd="N" onSelect={props.toggleN} />
          <MenuItem label={props.sideOpen ? t('アウトライナーとプロパティを隠す') : t('アウトライナーとプロパティを出す')} onSelect={props.toggleSide} />
          <MenuItem label={props.tlOpen ? t('タイムラインをたたむ') : t('タイムラインを広げる')} onSelect={props.toggleTl} />
          <MenuItem label={showFrame ? t('出力の範囲を隠す') : t('出力の範囲を表示')} onSelect={() => setShowFrame(!showFrame)} />
          <MenuSep />
          <MenuItem label={props.maximized ? t('エリアを元に戻す') : t('エリアを最大化')} kbd="Ctrl Space" onSelect={props.toggleMax} />
          <AddonMenuItems menu="view" />
        </Menu>
        <Menu id="select" label={t('選択')}>
          <MenuItem label={t('すべて')} kbd="A" onSelect={() => engine.selectAll()} />
          <MenuItem label={t('なし')} kbd="Alt A" disabled={!selIds.length} onSelect={() => engine.select(null)} />
          <MenuItem label={t('反転')} kbd="Ctrl I" onSelect={() => engine.invertSelection()} />
          <MenuSep />
          <MenuItem label={t('ボックス選択')} kbd="B" onSelect={() => engine.startBoxSelect()} />
          <AddonMenuItems menu="select" />
        </Menu>
        <Menu id="add" label={t('追加')}>
          <MenuLabel>{t('メッシュ')}</MenuLabel>
          {SHAPES.map(d => <MenuItem key={d.key} label={t(d.name)} disabled={!canAdd} onSelect={() => engine.addShape(d.s)} />)}
          <MenuSep />
          <MenuLabel>{t('ライト')}</MenuLabel>
          {LIGHT_TYPES.map(l => <MenuItem key={l.key} label={t(l.name)} disabled={!canAdd} onSelect={() => { engine.addLight(l.key); props.showTab('light'); }} />)}
          <MenuSep />
          <MenuLabel>{t('カメラ')}</MenuLabel>
          <MenuItem label={t('カメラ')} disabled={!canAdd} onSelect={() => { engine.addCamera(); props.showTab('cameradata'); }} />
          <MenuSep />
          <MenuItem label={t('MMD モデル…')} disabled={!canAdd} onSelect={props.onOpenFiles} />
          <AddonMenuItems menu="add" />
        </Menu>
        <Menu id="object" label={t('オブジェクト')}>
          <MenuLabel>{t('トランスフォーム')}</MenuLabel>
          <MenuItem label={t('移動')} kbd="G" disabled={!selIds.length} onSelect={() => engine.transform.start('grab')} />
          <MenuItem label={t('回転')} kbd="R" disabled={!selIds.length} onSelect={() => engine.transform.start('rotate')} />
          <MenuItem label={t('拡大縮小')} kbd="S" disabled={!selIds.length} onSelect={() => engine.transform.start('scale')} />
          <MenuItem label={t('位置・回転・大きさを元に戻す')} kbd="Alt G / R / S" disabled={!selIds.length}
                    onSelect={() => { engine.clearTransform('location'); engine.clearTransform('rotation'); engine.clearTransform('scale'); }} />
          <MenuSep />
          <MenuItem label={t('複製')} kbd="Shift D" disabled={!sel || !canAdd} onSelect={() => void engine.duplicateSelected()} />
          <MenuItem label={t('削除')} kbd="X" disabled={!sel} onSelect={() => engine.deleteSelected()} />
          <MenuItem label={t('名前を変更')} kbd="F2" disabled={!sel} onSelect={() => { if (!props.sideOpen) props.toggleSide(); requestRename(); }} />
          <MenuSep />
          <MenuLabel>{t('関係')}</MenuLabel>
          <MenuItem label={t('親子付け')} kbd="Ctrl P" disabled={selIds.length < 2} onSelect={() => engine.parentSelected()} />
          <MenuItem label={t('親子付けを外す')} kbd="Alt P" disabled={!selIds.length} onSelect={() => engine.clearParent()} />
          <MenuItem label={t('コレクションへ移動')} kbd="M" disabled={!selIds.length}
                    onSelect={() => { const r = viewportRef.current?.getBoundingClientRect(); engine.openCollectionMenu((r?.left ?? 0) + 120, (r?.top ?? 0) + 40); }} />
          <MenuSep />
          <MenuItem label={t('選択物を隠す')} kbd="H" disabled={!sel} onSelect={() => engine.hideSelected()} />
          <MenuItem label={t('ほかを隠す')} kbd="Shift H" disabled={!sel} onSelect={() => engine.hideSelected(true)} />
          <MenuItem label={t('すべて表示')} kbd="Alt H" onSelect={() => engine.revealAll()} />
          <MenuSep />
          <MenuItem label={t('キーフレームを挿入')} kbd="I" disabled={sel?.kind !== 'model'} onSelect={() => engine.insertKey()} />
          <AddonMenuItems menu="object" />
        </Menu>
        <span className="spacer" />
        <button type="button" className="hbtn icon-btn snap-btn" aria-pressed={snap} aria-label={t('スナップ')} title={t('スナップ (Shift+Tab)。G・R・S のあいだ Ctrl で入れ替わる')}
                onClick={() => engine.transform.setSnap(!snap)}>
          <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M4 2.5v5.5a4 4 0 0 0 8 0V2.5M4 5h2.5M9.5 5H12M6.5 2.5V8a1.5 1.5 0 0 0 3 0V2.5" /></svg>
        </button>
        <div className="shading-btns" role="group" aria-label={t('ビューポートの表示 (Z)')}>
          {(Object.keys(SHADING_ICONS) as ShadingMode[]).map(m => (
            <button key={m} type="button" className="hbtn icon-btn" aria-pressed={shading === m} aria-label={t(SHADING_LABELS[m])} title={t(SHADING_LABELS[m])}
                    onClick={() => engine.shading.set(m)}>{SHADING_ICONS[m]}</button>
          ))}
        </div>
        <button type="button" className="hbtn" aria-pressed={props.sideOpen} aria-controls="side-column" title={t('アウトライナーとプロパティ')} onClick={props.toggleSide}>{t('プロパティ')}</button>
      </div>
      <div className="view-body">
        <div className={`viewport${props.nOpen ? ' n-open' : ''}${props.toolsOpen ? '' : ' tools-hidden'}${boxSelect ? ' box-select' : ''}`} ref={el => { viewportRef.current = el; setViewportEl(el); }} onPointerDown={props.onViewportPointerDown}>
          <canvas id="c" ref={canvasRef} />
          {showFrame && <OutputFrame container={viewportEl} />}
          <RegionSelect container={viewportEl} />
          {props.toolsOpen && <div className="tools" role="group" aria-label={t('カメラの操作')}>
            <button type="button" aria-pressed={mode === 'orbit'} title={t('回転: ドラッグで注視点のまわりを回る')} aria-label={t('回転')} onClick={() => camera.setMode('orbit')}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.5 10a6.5 6.5 0 1 1-2-4.7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M15.5 2.5v3.6h-3.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <button type="button" aria-pressed={mode === 'pan'} title={t('移動: ドラッグで地面に沿って動く')} aria-label={t('移動')} onClick={() => camera.setMode('pan')}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v16M2 10h16M10 2 7.5 4.5M10 2l2.5 2.5M10 18l-2.5-2.5M10 18l2.5-2.5M2 10l2.5-2.5M2 10l2.5 2.5M18 10l-2.5-2.5M18 10l-2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          </div>}
          {poseMode && props.toolsOpen && (
            <div className="tools pose-tools" role="group" aria-label={t('ボーンの操作')}>
              <button type="button" aria-pressed={poseTool === 'rotate'} title={t('回す (R): ギズモでボーンを回す')} aria-label={t('ボーンを回す')} onClick={() => engine.pose.setTool('rotate')}>R</button>
              <button type="button" aria-pressed={poseTool === 'translate'} title={t('動かす (G): 動かせるボーン (IK・センターなど) をギズモで動かす')} aria-label={t('ボーンを動かす')} onClick={() => engine.pose.setTool('translate')}>G</button>
            </div>
          )}
          <div className="view-info" aria-live="off">{viewInfo}</div>
          {box && <div className="select-box" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />}
          {boxSelect && <div className="view-mode-hint">{t('ボックス選択: ドラッグで囲む (Shift で足す・Esc でやめる)')}</div>}
          {transform && (
            <div className="view-mode-hint" role="status">
              <b>{transform.mode === 'grab' ? t('移動') : transform.mode === 'rotate' ? t('回転') : t('拡大縮小')}</b>
              {transform.axis && ` ${transform.axis === 'x' ? t('X 軸') : t('Y 軸 (奥行き)')}`}
              {transform.snap && ` ${t('スナップ')}`}
              {`  ${transform.value}  `}
              <span className="dim">{transform.mode === 'grab' ? t('X・Y で軸、数字で値、Ctrl でスナップ。クリック・Enter で決定、Esc・右クリックでやめる') : t('数字で値、Ctrl でスナップ。クリック・Enter で決定、Esc・右クリックでやめる')}</span>
            </div>
          )}
          {empty && <div className="view-hint">{t('Shift+A (追加) で形やライトを置く・ファイル > MMD を読み込む… でモデルを置く')}</div>}
          <RecoverBanner />
          <ModelPicker />
          {props.nOpen && <NPanel />}
          <ViewContextMenu showSide={() => { if (!props.sideOpen) props.toggleSide(); }} />
          <ObjGizmo />
          <CollectionMenu />
          <ShadingMenu />
          <button type="button" className="npanel-toggle" aria-label={props.nOpen ? t('サイドバーを隠す') : t('サイドバーを出す')} aria-expanded={props.nOpen}
                  aria-controls="n-panel" title={t('サイドバー (N)')} onClick={props.toggleN}>{props.nOpen ? '›' : '‹'}</button>
          <div className="nav">
            <Gizmo />
            <button type="button" title={t('視点を戻す (Home)')} aria-label={t('視点を戻す')} onClick={() => camera.resetView()}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8 8 3l5.5 5M4.5 6.5V13h7V6.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

// 表示の切り替えのアイコン (Blender の見出しの右上と同じ並び)
const SHADING_ICONS: Record<ShadingMode, ReactNode> = {
  wireframe: <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.1"><circle cx="8" cy="8" r="5.5" /><ellipse cx="8" cy="8" rx="2.4" ry="5.5" /><path d="M2.5 8h11" /></svg>,
  solid: <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="#bdbdbd" /><circle cx="6.3" cy="6.3" r="1.6" fill="#ececec" /></svg>,
  material: <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="#c0505a" /><path d="M8 2.5a5.5 5.5 0 0 0 0 11z" fill="#5a88c0" /><circle cx="6.3" cy="6.3" r="1.4" fill="#f3d0d4" /></svg>,
  rendered: <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" /></svg>,
};
