import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Engine } from '../../engine';
import { requestRename } from '../components/sidebar/Outliner';

export type Area = 'view' | 'timeline' | 'shader' | 'outliner' | 'props' | null;

// Blender 風のキーボードショートカット。X と Home は、マウスが乗っている領域 (ビューポート / タイムライン) で働きが変わる
export function useShortcuts(engine: Engine, actions: {
  hoverArea: React.RefObject<Area>;
  openAddMenu: () => void;
  closeMenus: () => boolean; // 開いていたメニューを閉じたら true
  toggleN: () => void;   // ビューポートのサイドバー (N パネル)
  toggleTools: () => void; // ビューポートのツールバー (T)
  toggleMax: () => void;   // マウスが乗っているエリアを最大化する・戻す (Ctrl+Space)
  showSide: () => void; // 右の列 (アウトライナー・プロパティ) を開く (閉じていれば)
  openFiles: () => void;
  openProject: () => void;
  openAddons: () => void;
  closeDialog: () => boolean; // 開いていた窓 (アドオンマネージャー) を閉じたら true
  dialogOpen: () => boolean;
}) {
  const ref = useRef(actions);
  useLayoutEffect(() => { ref.current = actions; }); // (キーの処理は、いちばん新しい actions を使う)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = ref.current;
      // レンダリング中・レンダー結果を見ているあいだは、Esc (キャンセル・閉じる) だけを受け付ける
      if (engine.ui.state.rendering) { if (e.key === 'Escape') engine.output.cancel(); e.preventDefault(); return; }
      if (engine.ui.state.renderResult) { if (e.key === 'Escape') engine.output.closeResult(); return; }
      if (engine.ui.state.missingFiles) { if (e.key === 'Escape') engine.project.answerMissing('cancel'); return; }
      if (engine.ui.state.missingTextures) { if (e.key === 'Escape') engine.loader.answerTextures([]); return; }
      if (a.dialogOpen()) { if (e.key === 'Escape') a.closeDialog(); return; } // (アドオンマネージャーのあいだは、場面のショートカットを使わない)
      if (engine.transform.active) return; // (G・R・S で動かしているあいだのキーは、TransformTool が先に受け取る)
      if (e.key === 'Escape') { if (!a.closeMenus() && !engine.cancelBoxSelect()) engine.picker.close(); return; }
      // Ctrl+,: アドオンマネージャー (Blender のプリファレンスと同じキー)
      if (e.key === ',' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); a.openAddons(); return; }
      // F12: 画像をレンダリング、Ctrl+F12: アニメーションをレンダリング (Blender と同じ)
      if (e.key === 'F12') { e.preventDefault(); if (e.ctrlKey || e.metaKey) engine.output.renderAnimation(); else engine.output.renderImage(); return; }
      const t = e.target as HTMLElement;
      // 文字を打つ欄・選択肢を操作しているときは、ショートカットを効かせない。
      // スライダーは、自分で使う矢印キーと Enter だけを譲る (動かした直後に I でキーフレームを打てるように)
      if (t.closest('input, select, textarea, [contenteditable]')) return;
      if (t.closest('.bslider') && /^(Arrow|Enter$)/.test(e.key)) return;
      // ボタン (選択肢・チェックなど) に入っているときは、Space と Enter はそのボタンを押す
      if (t.closest('button, [role="slider"]') && (e.key === ' ' || e.key === 'Enter')) return;
      if (t.closest('.popover')) return; // 色選びなどの窓の中
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyO') { e.preventDefault(); if (e.shiftKey) a.openProject(); else a.openFiles(); return; }
      // 元に戻す (Ctrl+Z)・やり直す (Ctrl+Shift+Z / Ctrl+Y)
      if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyZ' || e.code === 'KeyY')) {
        e.preventDefault();
        if (e.code === 'KeyY' || e.shiftKey) void engine.history.redo(); else void engine.history.undo();
        return;
      }
      // Ctrl+Space: マウスが乗っているエリアを最大化する・戻す (Blender と同じ)
      if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); a.toggleMax(); return; }
      // Ctrl+I: 選択を反転
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyI') { e.preventDefault(); engine.invertSelection(); return; }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); engine.project.saveFile(e.altKey ? 'reference' : 'embedded'); return; }
      if (e.ctrlKey || e.metaKey) return;
      const hoverTl = a.hoverArea.current === 'timeline';
      // シェーダーエディターの上では、X (ノードを消す)・Shift+A (ノードを追加)・Home はエディターが受け持つ
      if (a.hoverArea.current === 'shader' && ['KeyX', 'Delete', 'KeyA', 'Home'].includes(e.code)) return;
      // 文字のキーは、配列や Alt で変わる e.key ではなく、キーの位置 (e.code) で見る
      switch (e.code) {
        case 'Numpad1': engine.camera.snapView('front'); break;
        case 'Numpad3': engine.camera.snapView('right'); break;
        case 'Numpad7': engine.camera.snapView('top'); break;
        case 'Space': e.preventDefault(); engine.clock.togglePlay(); break;
        case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) engine.clock.jumpToStart(); else engine.clock.stepFrame(-1); break;
        case 'ArrowRight': e.preventDefault(); if (e.shiftKey) engine.clock.jumpToEnd(); else engine.clock.stepFrame(1); break;
        case 'ArrowUp': e.preventDefault(); engine.jumpKey(1); break;
        case 'ArrowDown': e.preventDefault(); engine.jumpKey(-1); break;
        case 'KeyI':
          e.preventDefault();
          if (e.altKey) engine.deleteKeyHere(); else if (engine.pose.active) engine.insertSelectedBoneKey(); else engine.insertKey();
          break;
        case 'KeyX': case 'Delete':
          if (!(hoverTl && engine.deleteSelectedKeys()) && !engine.pose.active) engine.deleteSelected(); // (ポーズモードでは物を消さない)
          break;
        // ポーズモード (Blender と同じ): Tab で切り替え、R 回す・G 動かす、Alt+R・Alt+G で戻す
        case 'Tab':
          if (engine.selection.model || engine.pose.active) { e.preventDefault(); engine.togglePoseMode(); }
          break;
        // G 移動・R 回転・S 拡大縮小 (Alt で元に戻す)。ポーズモードの R・G はボーンのギズモ
        case 'KeyR':
          e.preventDefault();
          if (engine.pose.active) { if (e.altKey) engine.pose.resetSelected('rotate'); else engine.pose.setTool('rotate'); }
          else if (e.altKey) engine.clearTransform('rotation');
          else if (a.hoverArea.current !== 'timeline') engine.transform.start('rotate');
          break;
        case 'KeyG':
          e.preventDefault();
          if (engine.pose.active) { if (e.altKey) engine.pose.resetSelected('translate'); else engine.pose.setTool('translate'); }
          else if (e.altKey) engine.clearTransform('location');
          else if (a.hoverArea.current !== 'timeline') engine.transform.start('grab');
          break;
        case 'KeyS':
          if (engine.pose.active) break;
          e.preventDefault();
          if (e.altKey) engine.clearTransform('scale'); else if (a.hoverArea.current !== 'timeline') engine.transform.start('scale');
          break;
        // A: すべて選択、Alt+A: 選択を解除、Shift+A: 追加メニュー
        case 'KeyA':
          if (engine.pose.active) break;
          e.preventDefault();
          if (e.shiftKey) a.openAddMenu(); else if (e.altKey) engine.select(null); else engine.selectAll();
          break;
        // B: ボックス選択
        case 'KeyB':
          if (!engine.pose.active) engine.startBoxSelect();
          break;
        case 'KeyN':
          a.toggleN();
          break;
        case 'KeyD':
          if (e.shiftKey && !engine.pose.active) { e.preventDefault(); void engine.duplicateSelected(); } // Shift+D: 複製
          break;
        case 'KeyT':
          a.toggleTools();
          break;
        // 隠す (Blender と同じ): H 選んでいる物、Shift+H ほかの物、Alt+H 全部見せる
        case 'KeyH':
          if (engine.pose.active) break;
          e.preventDefault();
          if (e.altKey) engine.revealAll(); else engine.hideSelected(e.shiftKey);
          break;
        case 'F2':
          e.preventDefault();
          if (!engine.ui.state.sel) break;
          a.showSide();
          requestRename(); // (アウトライナーで名前を変える)
          break;
        case 'Home':
          e.preventDefault();
          if (hoverTl) dispatchEvent(new Event('timeline-fit')); else engine.camera.resetView();
          break;
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [engine]);
}
