import { useEffect, useRef } from 'react';
import type { Engine } from '../../engine';

export type Area = 'view' | 'timeline' | 'shader' | null;

// Blender 風のキーボードショートカット。X と Home は、マウスが乗っている領域 (ビューポート / タイムライン) で働きが変わる
export function useShortcuts(engine: Engine, actions: {
  hoverArea: React.RefObject<Area>;
  openAddMenu: () => void;
  closeMenus: () => boolean; // 開いていたメニューを閉じたら true
  toggleSide: () => void;
  openFiles: () => void;
}) {
  const ref = useRef(actions);
  ref.current = actions;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = ref.current;
      if (e.key === 'Escape') { if (!a.closeMenus()) engine.picker.close(); return; }
      const t = e.target as HTMLElement;
      // 文字を打つ欄・選択肢を操作しているときは、ショートカットを効かせない。
      // スライダーは、自分で使う矢印キーと Enter だけを譲る (動かした直後に I でキーフレームを打てるように)
      if (t.closest('input, select, textarea, [contenteditable]')) return;
      if (t.closest('.bslider') && /^(Arrow|Enter$)/.test(e.key)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); a.openFiles(); return; }
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
          if (e.altKey) engine.deleteKeyHere(); else engine.insertKey();
          break;
        case 'KeyX': case 'Delete':
          if (!(hoverTl && engine.deleteSelectedKeys())) engine.deleteSelected();
          break;
        case 'KeyA':
          if (e.shiftKey) { e.preventDefault(); a.openAddMenu(); } else if (e.altKey) { e.preventDefault(); engine.select(null); }
          break;
        case 'KeyN':
          a.toggleSide();
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
