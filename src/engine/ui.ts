import { createStore } from '../store';
import { TL_DEFAULT_END } from './constants';
import { FX_LEVEL_DEFAULT, type FxLevel, type FxState } from './postfx';

// --- 画面の部品 (React) に知らせる状態 ---
export interface SelInfo {
  id: number; kind: 'shape' | 'model'; name: string; c: number;
  x: number; y: number; z: number; r: number; animated: boolean;
}
export interface UiState {
  mode: 'orbit' | 'pan';
  sel: SelInfo | null;
  modelVersion: number;  // 選んでいるモデルの中身 (表情・ボーンの一覧) が変わった
  values: number;        // 表情・ボーンの値が変わった
  canAdd: boolean;
  frame: number; playing: boolean; start: number; end: number;
  keysVersion: number;   // タイムラインに並べるキーフレームが変わった
  fxState: FxState; fxLevel: FxLevel;
  toast: { text: string; id: number } | null;
  palette: { x: number; y: number; c: number } | null;
  viewInfo: string;
}

export const ui = createStore<UiState>({
  mode: 'orbit', sel: null, modelVersion: 0, values: 0, canAdd: true,
  frame: 0, playing: false, start: 0, end: TL_DEFAULT_END, keysVersion: 0,
  fxState: { ao: false, dof: false, bloom: false, diffusion: false, color: false }, fxLevel: { ...FX_LEVEL_DEFAULT },
  toast: null, palette: null, viewInfo: '',
});

export const bump = (k: 'modelVersion' | 'values' | 'keysVersion') => ui.set({ [k]: ui.get()[k] + 1 });
// 再生中は毎フレーム値が変わるので、パネルの描き直しは 0.1 秒に 1 回まで
let valuesAt = 0;
export function bumpValuesThrottled() {
  const now = performance.now();
  if (now - valuesAt < 100) return;
  valuesAt = now;
  bump('values');
}

// --- お知らせ (読み込み中・エラーなど)。ms が 0 なら出しっぱなし ---
let toastTimer = 0, toastId = 0;
export function toast(text: string, ms = 4000) {
  ui.set({ toast: { text, id: ++toastId } });
  clearTimeout(toastTimer);
  if (ms) toastTimer = window.setTimeout(() => ui.set({ toast: null }), ms);
}
export function hideToast() {
  clearTimeout(toastTimer);
  ui.set({ toast: null });
}
