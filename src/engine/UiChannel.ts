import { TL_DEFAULT_END } from '../core/constants';
import { OUTPUT_DEFAULT, type OutputSettings } from '../core/output';
import { createStore, type Store } from '../core/store';
import { FX_LEVEL_DEFAULT, type FxLevel, type FxState } from './render/postfx';

// --- エンジンから画面 (React) へ知らせる状態と、お知らせ ---
// エンジンの各部は、画面に見せたいことをここに書く (React の部品は Store を購読して描き直す)
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
  hairHang: boolean | null; // 選んでいるモデルの髪を重力で垂らしているか (髪の形を保つ錘がなければ null)
  materialsVersion: number; // マテリアル (スロット・ノード・値) が変わった
  projectName: string | null; // 保存した・開いたプロジェクトの名前
  output: OutputSettings;   // 出力 (レンダリングの大きさ・形式)
  rendering: { done: number; total: number } | null; // 動画をレンダリング中 (描いたフレーム数)
  renderResult: { url: string; name: string; width: number; height: number } | null; // レンダリングした画像 (保存する前に見せる)
  remote: 'off' | 'waiting' | 'connected'; // 外部からの操作 (MCP サーバーとのつながり)
  history: { labels: string[]; index: number }; // 元に戻す・やり直しの履歴 (index がいまの状態)
  // 参照だけのプロジェクトを開くときに見つからないファイル (探してもらう)
  missingFiles: { project: string; files: { name: string; size?: number; source?: string }[] } | null;
}
type Version = 'modelVersion' | 'values' | 'keysVersion' | 'materialsVersion';

export class UiChannel {
  readonly store: Store<UiState> = createStore<UiState>({
    mode: 'orbit', sel: null, modelVersion: 0, values: 0, canAdd: true,
    frame: 0, playing: false, start: 0, end: TL_DEFAULT_END, keysVersion: 0,
    fxState: { ao: false, dof: false, bloom: false, diffusion: false, color: false }, fxLevel: { ...FX_LEVEL_DEFAULT },
    toast: null, palette: null, viewInfo: '', hairHang: null, materialsVersion: 0, projectName: null,
    output: { ...OUTPUT_DEFAULT }, rendering: null, renderResult: null, remote: 'off', missingFiles: null, history: { labels: ['最初'], index: 0 },
  });
  private valuesAt = 0;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private toastId = 0;

  get state() { return this.store.get(); }
  set(patch: Partial<UiState>) { this.store.set(patch); }
  // 「変わった」ことだけを知らせる番号を進める
  bump(k: Version) { this.store.set({ [k]: this.state[k] + 1 }); }
  // 再生中は毎フレーム値が変わるので、パネルの描き直しは 0.1 秒に 1 回まで
  bumpValuesThrottled() {
    const now = performance.now();
    if (now - this.valuesAt < 100) return;
    this.valuesAt = now;
    this.bump('values');
  }

  // お知らせ (読み込み中・エラーなど)。ms が 0 なら出しっぱなし
  toast(text: string, ms = 4000) {
    this.set({ toast: { text, id: ++this.toastId } });
    clearTimeout(this.toastTimer);
    if (ms) this.toastTimer = setTimeout(() => this.set({ toast: null }), ms);
  }
  hideToast() {
    clearTimeout(this.toastTimer);
    this.set({ toast: null });
  }
}
