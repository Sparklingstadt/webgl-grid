import type * as THREE from 'three';
import type { Animation } from '../core/animation';
import type { ClonerSettings } from '../core/cloner';
import type { Deformer } from '../core/deform';
import type { LightSettings } from '../core/light';
import { MODEL_KIND } from '../core/shapes';
import type { BoneValue } from '../core/types';

// MMDLoader などの three.js の付属品は、型の付いていない内部の値も使うので any で扱う
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

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
  mesh?: THREE.Mesh;
  model?: Any;                        // THREE.SkinnedMesh (MMD)
  animated?: boolean;
  motion?: MotionInfo | null;
  motionFile?: File;                  // 付けた .vmd (プロジェクトに入れる)
  pose?: Map<number, BoneValue>;      // 手で動かしたボーン
  anim?: Animation | null;            // キーフレーム (ボーン・表情のチャンネルごと)
  solvers?: { ik: Any; grant: Any };  // IK と付与の計算
  boneSel?: number;                   // サイドバーで選んでいるボーン
  slots: (string | null)[];           // マテリアルスロット (マテリアルの id。なしは null)
  activeSlot?: number;                // サイドバーで選んでいるスロット
  cloner?: ClonerSettings | null;     // クローナー (並べ方。なければ普通の物)
  deformers?: Deformer[] | null;      // デフォーマ (形を曲げる・ねじるなど)
  light?: LightSettings | null;       // ライト (ライトのオブジェクトだけ)
  ext?: Record<string, unknown>;      // アドオンの、物ごとの設定 ("アドオンの id.名前" → 値)
  highlighted?: boolean;              // 掴んでいるので明るくしている
}
export type ModelObj = Obj & { model: Any };
export const isModel = (o: Obj | null | undefined): o is ModelObj => o?.s === MODEL_KIND;
// 物の種類 (画面・プロジェクト・MCP で使う名前)
export type ObjKind = 'shape' | 'model' | 'light';
export const kindOf = (o: Obj): ObjKind => (o.light ? 'light' : isModel(o) ? 'model' : 'shape');
// 形 (ライトでも MMD モデルでもない物)
export const isShape = (o: Obj | null | undefined): o is Obj => !!o && kindOf(o) === 'shape';
