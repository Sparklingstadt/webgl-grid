import type { CameraSettings } from '../core/camera';
import type { LightSettings } from '../core/light';
import { TL_DEFAULT_END } from '../core/constants';
import { OUTPUT_DEFAULT, type OutputSettings } from '../core/output';
import { normalizeScene, type SceneSettings } from '../core/scene';
import { createStore, type Store } from '../core/store';
import type { AddonInfo } from './addons/Addons';
import { getLang, langEvents, msg, type Lang } from '../core/i18n';
import { MME_DEFAULTS, type MmeSettings } from '../core/mme/settings.ts';
import { FX_LEVEL_DEFAULT, type FxLevel, type FxState } from './render/postfx';
import type { ShadingMode } from './render/Viewport';

// --- エンジンから画面 (React) へ知らせる状態と、お知らせ ---
// エンジンの各部は、画面に見せたいことをここに書く (React の部品は Store を購読して描き直す)
export interface SelInfo {
  id: number; kind: 'shape' | 'model' | 'light' | 'camera'; name: string; c: number;
  light: LightSettings | null;   // ライトの設定 (ライトだけ)
  camera: CameraSettings | null; // カメラの設定 (カメラだけ)
  x: number; y: number; z: number; r: number; scale: number; animated: boolean;
}
// MME 互換のエフェクト 1 つのコンパイルの結果 (errors は最大 20。errorCount は全部の数)。warnings はコンパイラの警告と、描いたときのそのエフェクトの警告。
// id は読んだエフェクトごとに違う (一覧の行の key)
export interface MmeEffectUi { id: string; name: string; ok: boolean; errors: { code: string; where: string; message: string }[]; errorCount: number; warnings: string[] }
// warnings: どのエフェクトのものでもない、描くときの警告 (セルフシャドウを切った・モデルを描けないなど)
export interface MmeUiState { settings: MmeSettings; object: MmeEffectUi | null /* 選んでいる物の .fx */; posts: (MmeEffectUi & { enabled: boolean })[]; warnings: string[] }
export interface UiState {
  mode: 'orbit' | 'pan';
  sel: SelInfo | null;   // アクティブな物
  selIds: number[];      // 選んでいる物 (置いた順)
  boxSelect: boolean;    // ボックス選択 (B) を待っている
  box: { x0: number; y0: number; x1: number; y1: number } | null; // ドラッグしているボックス (クライアント座標)
  contextMenu: { x: number; y: number } | null; // ビューポートの右クリックのメニュー (クライアント座標)
  collectionMenu: { x: number; y: number } | null; // 「コレクションへ移動」(M) のメニュー
  shading: ShadingMode;  // ビューポートの表示 (Z)
  shadingMenu: { x: number; y: number } | null; // Z のメニュー
  regionSelect: boolean; // レンダー範囲 (Ctrl+B) をドラッグで決めている
  snap: boolean;         // スナップ (見出しの磁石)。G・R・S で Ctrl を押すと逆になる
  transform: { mode: 'grab' | 'rotate' | 'scale'; axis: 'x' | 'z' | null; value: string; count: number; snap: boolean } | null; // G・R・S で動かしている途中
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
  scene: SceneSettings;     // シーンの設定 (空・床・太陽・部屋の光)
  recovery: { time: number; name: string | null; banner: boolean } | null; // 自動保存した前回の続き (banner: 知らせを出す)
  // 参照だけのプロジェクトを開くときに見つからないファイル (探してもらう)
  missingFiles: { project: string; files: { name: string; size?: number; source?: string }[] } | null;
  // .pmx を読むときに見つからないテクスチャ (探してもらう)
  missingTextures: { model: string; files: string[] } | null;
  addons: AddonInfo[];      // アドオンの一覧 (アドオンマネージャー)
  lang: Lang;               // 画面の言語
  poseMode: boolean;        // ポーズモード (MMD モデルのボーンをビューポートで動かす)
  poseTool: 'rotate' | 'translate';
  rigShown: boolean;        // 物理演算の剛体と関節を表示している (選んでいるモデル)
  modelPicker: boolean;     // models フォルダのモデルの一覧を出している
  addonsVersion: number;       // アドオンのメニュー・パネル・値が変わった
  sceneVersion: number;        // 置いた物 (増減・名前・表示) が変わった (アウトライナー)
  mme: MmeUiState;             // レンダーエンジン (標準 / MME 互換) と MME 互換のエフェクト
}
type Version = 'modelVersion' | 'values' | 'keysVersion' | 'materialsVersion' | 'addonsVersion' | 'sceneVersion';

export class UiChannel {
  readonly store: Store<UiState> = createStore<UiState>({
    mode: 'orbit', sel: null, selIds: [], boxSelect: false, box: null, contextMenu: null, collectionMenu: null, shading: 'rendered', shadingMenu: null, regionSelect: false, snap: false, transform: null, modelVersion: 0, values: 0, canAdd: true,
    frame: 0, playing: false, start: 0, end: TL_DEFAULT_END, keysVersion: 0,
    fxState: { ao: false, dof: false, bloom: false, diffusion: false, color: false }, fxLevel: { ...FX_LEVEL_DEFAULT },
    toast: null, palette: null, viewInfo: '', hairHang: null, materialsVersion: 0, projectName: null,
    output: { ...OUTPUT_DEFAULT }, rendering: null, renderResult: null, remote: 'off', missingFiles: null, missingTextures: null, history: { labels: [msg('最初')], index: 0 }, recovery: null, scene: normalizeScene(undefined),
    addons: [], addonsVersion: 0, lang: getLang(), poseMode: false, poseTool: 'rotate', rigShown: false, modelPicker: false, sceneVersion: 0,
    mme: { settings: { ...MME_DEFAULTS }, object: null, posts: [], warnings: [] },
  });
  constructor() {
    langEvents.on('changed', lang => this.set({ lang }));
  }
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
