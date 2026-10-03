import { useEffect, useRef, useState } from 'react';
import { SHAPES } from '../../core/shapes';
import { useEngine, useUi } from '../EngineContext';
import { Gizmo } from './Gizmo';
import { Menu, MenuItem, MenuLabel, MenuSep } from './Menu';
import { Sidebar, type SideTab } from './sidebar/Sidebar';
import { OutputFrame, useShowFrame } from './OutputFrame';
import { RecoverBanner } from './Overlays';

// 3D ビューポート: 見出し (ビュー・追加・オブジェクトのメニュー)、左のツールバー、左上の文字、
// 右上のナビゲーションギズモ、右のサイドバー
export function ViewportArea(props: {
  sideOpen: boolean; toggleSide: () => void; tlOpen: boolean; toggleTl: () => void;
  sideTab: SideTab; setSideTab: (t: SideTab) => void; onOpenFiles: () => void; onLoadPose: () => void; onOpenShaderEditor: () => void;
  onViewportPointerDown: () => void; showObjectTab: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const engine = useEngine();
  const { camera } = engine;
  const mode = useUi(s => s.mode);
  const canAdd = useUi(s => s.canAdd);
  const sel = useUi(s => s.sel);
  const viewInfo = useUi(s => s.viewInfo);
  const [showFrame, setShowFrame] = useShowFrame();
  const [viewportEl, setViewportEl] = useState<HTMLDivElement | null>(null);
  // canvas ができたら描き始め、なくなるときに片付ける
  useEffect(() => {
    engine.mount(canvasRef.current!, viewportRef.current!);
    return () => engine.unmount();
  }, [engine]);

  return (
    <section className="area" aria-label="3D ビューポート">
      <div className="area-header">
        <svg className="editor-type" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2 15.5 5.5v7L9 16 2.5 12.5v-7z M9 2v7 M2.5 5.5 9 9l6.5-3.5" fill="none" stroke="#ccc" strokeWidth="1.3" strokeLinejoin="round" /></svg>
        <Menu id="view" label="ビュー">
          <MenuItem label="前から見る" kbd="テンキー 1" onSelect={() => camera.snapView('front')} />
          <MenuItem label="右から見る" kbd="テンキー 3" onSelect={() => camera.snapView('right')} />
          <MenuItem label="上から見る" kbd="テンキー 7" onSelect={() => camera.snapView('top')} />
          <MenuItem label="視点を戻す" kbd="Home" onSelect={() => camera.resetView()} />
          <MenuSep />
          <MenuItem label={props.sideOpen ? 'サイドバーを隠す' : 'サイドバーを出す'} kbd="N" onSelect={props.toggleSide} />
          <MenuItem label={props.tlOpen ? 'タイムラインをたたむ' : 'タイムラインを広げる'} onSelect={props.toggleTl} />
          <MenuItem label={showFrame ? '出力の範囲を隠す' : '出力の範囲を表示'} onSelect={() => setShowFrame(!showFrame)} />
        </Menu>
        <Menu id="add" label="追加">
          <MenuLabel>メッシュ</MenuLabel>
          {SHAPES.map(d => <MenuItem key={d.key} label={d.name} disabled={!canAdd} onSelect={() => engine.addShape(d.s)} />)}
          <MenuSep />
          <MenuItem label="MMD モデル…" disabled={!canAdd} onSelect={props.onOpenFiles} />
        </Menu>
        <Menu id="object" label="オブジェクト">
          <MenuItem label="削除" kbd="X" disabled={!sel} onSelect={() => engine.deleteSelected()} />
          <MenuItem label="選択を解除" kbd="Alt A" disabled={!sel} onSelect={() => engine.select(null)} />
          <MenuSep />
          <MenuItem label={sel?.cloner ? 'クローナーをやめる' : 'クローナーにする'} disabled={!sel}
                    onSelect={() => { engine.setCloner(sel?.cloner ? null : {}); props.showObjectTab(); }} />
          <MenuSep />
          <MenuItem label="キーフレームを挿入" kbd="I" disabled={sel?.kind !== 'model'} onSelect={() => engine.insertKey()} />
        </Menu>
        <span className="spacer" />
        <button type="button" className="hbtn" aria-pressed={props.sideOpen} aria-controls="sidebar" title="サイドバー (N)" onClick={props.toggleSide}>サイドバー</button>
      </div>
      <div className="view-body">
        <div className="viewport" ref={el => { viewportRef.current = el; setViewportEl(el); }} onPointerDown={props.onViewportPointerDown}>
          <canvas id="c" ref={canvasRef} />
          {showFrame && <OutputFrame container={viewportEl} />}
          <div className="tools" role="group" aria-label="カメラの操作">
            <button type="button" aria-pressed={mode === 'orbit'} title="回転: ドラッグで注視点のまわりを回る" aria-label="回転" onClick={() => camera.setMode('orbit')}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.5 10a6.5 6.5 0 1 1-2-4.7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M15.5 2.5v3.6h-3.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <button type="button" aria-pressed={mode === 'pan'} title="移動: ドラッグで地面に沿って動く" aria-label="移動" onClick={() => camera.setMode('pan')}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v16M2 10h16M10 2 7.5 4.5M10 2l2.5 2.5M10 18l-2.5-2.5M10 18l2.5-2.5M2 10l2.5-2.5M2 10l2.5 2.5M18 10l-2.5-2.5M18 10l-2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          </div>
          <div className="view-info" aria-live="off">{viewInfo}</div>
          <RecoverBanner />
          <div className="nav">
            <Gizmo />
            <button type="button" title="視点を戻す (Home)" aria-label="視点を戻す" onClick={() => camera.resetView()}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8 8 3l5.5 5M4.5 6.5V13h7V6.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
            </button>
          </div>
        </div>
        {props.sideOpen && <Sidebar tab={props.sideTab} setTab={props.setSideTab} onLoadPose={props.onLoadPose} onOpenShaderEditor={props.onOpenShaderEditor} />}
      </div>
    </section>
  );
}
