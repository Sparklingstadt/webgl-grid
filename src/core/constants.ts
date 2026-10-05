import { msg } from './i18n';

// エンジン全体で使う定数

export const FPS = 30;              // MMD のモーションと同じ 1 秒 30 フレーム
export const TL_DEFAULT_END = 250;  // Blender と同じ、最初の終了フレーム
export const MAX_BOXES = 32;        // 置ける物の数
export const VIEWPORT_BG = '#3d3d3d'; // Blender のビューポートの灰色
export const DEG = Math.PI / 180;

// 以前のシェーダーと同じ画角 (画面の高さに対して焦点距離 1.6)
export const DEFAULT_FOV = 2 * Math.atan(0.5 / 1.6) * 180 / Math.PI;

// MMD の 1 単位をこの大きさで置く。標準的な身長 20 のモデルが高さ 2 (立方体 2 個分) になる。
// どのモデルも同じ倍率なので、人物とステージの大きさの関係や、カメラモーションの位置が MMD と同じになる
const MODEL_HEIGHT = 2;
export const MMD_SCALE = MODEL_HEIGHT / 20;
// MME 互換の空間 (MMD の単位) は、この場面の 1 単位をこの倍にしたもの (= 10)
export const MMD_UNITS = 1 / MMD_SCALE;

// --- 色 (リニア値) ---
export const PALETTE: [number, number, number][] = [
  [0.85, 0.62, 0.32], // 黄土
  [0.85, 0.22, 0.18], // 赤
  [0.12, 0.58, 0.52], // 青緑
  [0.18, 0.32, 0.85], // 青
  [0.55, 0.28, 0.80], // 紫
  [0.35, 0.70, 0.22], // 緑
  [0.90, 0.32, 0.55], // ピンク
  [0.62, 0.66, 0.72], // 灰
];
export const PALETTE_NAMES = [msg('黄土'), msg('赤'), msg('青緑'), msg('青'), msg('紫'), msg('緑'), msg('ピンク'), msg('灰')];
export const paletteCss = (i: number) => `rgb(${PALETTE[i].map(v => Math.round(Math.pow(v, 1 / 2.2) * 255)).join(',')})`;
