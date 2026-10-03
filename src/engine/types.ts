import type * as THREE from 'three';

// MMDLoader などの three.js の付属品は、型の付いていない内部の値も使うので any で扱う
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

// 手で動かしたボーンの値: 最初の姿勢からのオイラー角 (度、YXZ の順) と位置のずれ (MMD の単位)
export interface BoneValue { rx: number; ry: number; rz: number; px: number; py: number; pz: number }
export const ZERO_BONE: BoneValue = { rx: 0, ry: 0, rz: 0, px: 0, py: 0, pz: 0 };

// キーフレーム 1 つ分: ポーズ (手で動かしたボーン) と表情
export interface PoseKey { pose: Map<number, BoneValue>; morphs: Float32Array | null }

// VMD モーションの再生の設定と、タイムラインに印を付けるキーフレームの位置 (フレーム番号)
export interface MotionInfo { action: THREE.AnimationAction; duration: number; frames: Int32Array }

// --- 置いた物 (形と PMX モデル) ---
// x, z は底面中心、y は積み重ねで決まる高さ、py は画面に表示している高さ (落下中は y より上)、vy は落下速度
// r は縦軸まわりの回転角 (ラジアン)、c は色 (モデルは -1)
// s は種類 (0: 立方体, 1: トーラス, 2: 三角錐, 3: PMX モデル)
// h は高さ、hx / hz は上から見た足場の半分の幅 (回転前)
// node は three.js の表示用オブジェクト
export interface Obj {
  id: number;
  x: number; y: number; z: number; c: number; s: number; r: number; py: number; vy: number;
  h: number; hx: number; hz: number;
  node: THREE.Group;
  mesh?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  model?: Any;                        // THREE.SkinnedMesh (MMD)
  animated?: boolean;
  motion?: MotionInfo | null;
  pose?: Map<number, BoneValue>;      // 手で動かしたボーン
  keys?: Map<number, PoseKey> | null; // キーフレーム (フレーム番号 → ポーズと表情)
  solvers?: { ik: Any; grant: Any };  // IK と付与の計算
  boneSel?: number;                   // サイドバーで選んでいるボーン
  outlined?: boolean;                 // 選択中のオレンジの輪郭線を付けている
}
