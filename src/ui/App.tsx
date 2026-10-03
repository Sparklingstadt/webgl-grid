import { useCallback, useEffect, useRef, useState } from 'react';
import { MenuContext } from './components/Menu';
import { Palette, Toast } from './components/Overlays';
import type { SideTab } from './components/sidebar/Sidebar';
import { BottomArea, type BottomEditor } from './components/BottomArea';
import { TopBar } from './components/TopBar';
import { ViewportArea } from './components/ViewportArea';
import { useEngine } from './EngineContext';
import { useShortcuts, type Area } from './hooks/useShortcuts';

// 幅の狭い画面では、サイドバーはビューポートの上に重ねて出す (最初はしまっておく)
const NARROW = '(max-width: 760px)';
const isNarrow = () => matchMedia(NARROW).matches;

// Blender 風の画面全体: 上のバー・3D ビューポート (+サイドバー)・タイムライン
export default function App() {
  const engine = useEngine();
  const [sideOpen, setSideOpen] = useState(() => !isNarrow());
  const [tlOpen, setTlOpen] = useState(true);
  const [sideTab, setSideTab] = useState<SideTab>('object');
  const [bottom, setBottom] = useState<BottomEditor>('timeline');
  const [bottomH, setBottomH] = useState(() => (isNarrow() ? 168 : 150)); // 下の領域の高さ (px)。境目をドラッグで変える
  // シェーダーエディターにしたときは、ノードが見える高さまで広げる (Blender の「シェーディング」のように)
  const showEditor = useCallback((e: BottomEditor) => {
    setBottom(e);
    if (e === 'shader') { setTlOpen(true); setBottomH(h => Math.max(h, Math.round(innerHeight * 0.45))); }
  }, []);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const hoverArea = useRef<Area>(null);
  const pmxInput = useRef<HTMLInputElement>(null);
  const poseInput = useRef<HTMLInputElement>(null);
  const openFiles = useCallback(() => pmxInput.current?.click(), []);
  const projectInput = useRef<HTMLInputElement>(null);
  const openProject = useCallback(() => projectInput.current?.click(), []);
  const openPose = useCallback(() => poseInput.current?.click(), []);
  const toggleSide = useCallback(() => setSideOpen(o => !o), []);

  // メニューの外を押したら閉じる
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.menu')) setOpenMenu(null); };
    addEventListener('pointerdown', onDown, true);
    return () => removeEventListener('pointerdown', onDown, true);
  }, [openMenu]);

  const openMenuRef = useRef(openMenu);
  openMenuRef.current = openMenu;
  useShortcuts(engine, {
    hoverArea,
    openAddMenu: () => setOpenMenu('add'),
    closeMenus: () => { const was = !!openMenuRef.current; setOpenMenu(null); return was; },
    toggleSide,
    openFiles,
    openProject,
  });

  return (
    <MenuContext.Provider value={{ open: openMenu, setOpen: setOpenMenu }}>
      <div id="app" className={[!sideOpen && 'side-hidden', !tlOpen && 'tl-hidden'].filter(Boolean).join(' ')}
           style={{ '--tl-h': `${bottomH}px` } as React.CSSProperties}>
        <TopBar onOpenFiles={openFiles} onLoadPose={openPose} onOpenProject={openProject} />
        <div style={{ display: 'contents' }} onPointerEnter={() => { hoverArea.current = 'view'; }}>
          <ViewportArea sideOpen={sideOpen} toggleSide={toggleSide} tlOpen={tlOpen} toggleTl={() => setTlOpen(o => !o)}
                        sideTab={sideTab} setSideTab={setSideTab} onOpenFiles={openFiles} onLoadPose={openPose}
                        onOpenShaderEditor={() => showEditor('shader')}
                        onViewportPointerDown={() => { if (isNarrow()) setSideOpen(false); }} />
        </div>
        <div className="area-resizer" role="separator" aria-orientation="horizontal" aria-label="下の領域の高さ"
             onPointerDown={e => {
               const startY = e.clientY, startH = bottomH;
               const move = (ev: PointerEvent) => setBottomH(Math.min(Math.max(startH + startY - ev.clientY, 60), innerHeight - 160));
               const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
               addEventListener('pointermove', move);
               addEventListener('pointerup', up);
             }} />
        <BottomArea editor={bottom} setEditor={showEditor} open={tlOpen} onHover={a => { hoverArea.current = a; }} />
      </div>
      <Toast />
      <Palette />
      <input type="file" ref={pmxInput} multiple hidden
             accept=".pmx,.vmd,.vpd,.png,.jpg,.jpeg,.bmp,.tga,.gif,.spa,.sph,image/*,.mp3,.wav,.ogg,.oga,.m4a,.aac,.flac,.opus,audio/*"
             onChange={e => {
               const files = [...e.currentTarget.files ?? []];
               e.currentTarget.value = ''; // 同じファイルをもう一度選べるようにする
               if (files.length) engine.loadFiles(files);
             }} />
      <input type="file" ref={projectInput} accept=".wgp" hidden
             onChange={e => {
               const f = e.currentTarget.files?.[0];
               e.currentTarget.value = '';
               if (f) engine.openProject(f);
             }} />
      <input type="file" ref={poseInput} accept=".vpd" hidden
             onChange={e => {
               const f = e.currentTarget.files?.[0];
               e.currentTarget.value = '';
               if (f) engine.loadPoseFile(f);
             }} />
    </MenuContext.Provider>
  );
}
