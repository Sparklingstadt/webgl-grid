// ポーズとキーフレームのデータ (three.js の場面に依存しない)

// 手で動かしたボーンの値: 最初の姿勢からのオイラー角 (度、YXZ の順) と位置のずれ (MMD の単位)
export interface BoneValue { rx: number; ry: number; rz: number; px: number; py: number; pz: number }
export const ZERO_BONE: BoneValue = { rx: 0, ry: 0, rz: 0, px: 0, py: 0, pz: 0 };

// キーフレーム 1 つ分: ポーズ (手で動かしたボーン) と表情
export interface PoseKey { pose: Map<number, BoneValue>; morphs: Float32Array | null }
