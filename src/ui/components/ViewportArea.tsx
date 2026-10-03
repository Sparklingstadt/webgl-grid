import { useEffect, useRef, useState } from 'react';
import { t } from '../../core/i18n';
import { LIGHT_TYPES } from '../../core/light';
import { SHAPES } from '../../core/shapes';
import { useEngine, useUi } from '../EngineContext';
import { AddonMenuItems } from './addons/AddonMenuItems';
import { BSelect } from './controls/BSelect';
import { Gizmo } from './Gizmo';
import { Menu, MenuItem, MenuLabel, MenuSep } from './Menu';
import type { SideTab } from './sidebar/Sidebar';
import { Icon } from './icons';
import { NPanel } from './NPanel';
import { OutputFrame, useShowFrame } from './OutputFrame';
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
          <MenuItem label={t('MMD モデル…')} disabled={!canAdd} onSelect={props.onOpenFiles} />
          <AddonMenuItems menu="add" />
        </Menu>
        <Menu id="object" label={t('オブジェクト')}>
          <MenuItem label={t('複製')} kbd="Shift D" disabled={!sel || !canAdd} onSelect={() => void engine.duplicateSelected()} />
          <MenuItem label={t('削除')} kbd="X" disabled={!sel} onSelect={() => engine.deleteSelected()} />
          <MenuItem label={t('名前を変更')} kbd="F2" disabled={!sel} onSelect={() => { if (!props.sideOpen) props.toggleSide(); requestRename(); }} />
          <MenuSep />
          <MenuItem label={t('選択物を隠す')} kbd="H" disabled={!sel} onSelect={() => engine.hideSelected()} />
          <MenuItem label={t('ほかを隠す')} kbd="Shift H" disabled={!sel} onSelect={() => engine.hideSelected(true)} />
          <MenuItem label={t('すべて表示')} kbd="Alt H" onSelect={() => engine.revealAll()} />
          <MenuSep />
          <MenuItem label={t('キーフレームを挿入')} kbd="I" disabled={sel?.kind !== 'model'} onSelect={() => engine.insertKey()} />
          <AddonMenuItems menu="object" />
        </Menu>
        <span className="spacer" />
        <button type="button" className="hbtn" aria-pressed={props.sideOpen} aria-controls="side-column" title={t('アウトライナーとプロパティ')} onClick={props.toggleSide}>{t('プロパティ')}</button>
      </div>
      <div className="view-body">
        <div className={`viewport${props.nOpen ? ' n-open' : ''}${props.toolsOpen ? '' : ' tools-hidden'}${boxSelect ? ' box-select' : ''}`} ref={el => { viewportRef.current = el; setViewportEl(el); }} onPointerDown={props.onViewportPointerDown}>
          <canvas id="c" ref={canvasRef} />
          {showFrame && <OutputFrame container={viewportEl} />}
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
          {empty && <div className="view-hint">{t('Shift+A (追加) で形やライトを置く・ファイル > MMD を読み込む… でモデルを置く')}</div>}
          <RecoverBanner />
          <ModelPicker />
          {props.nOpen && <NPanel />}
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
