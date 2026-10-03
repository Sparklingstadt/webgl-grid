import * as THREE from 'three';
import { DEG } from './constants';
import { ZERO_BONE, type BoneValue, type PoseKey } from './types';

// キーフレームの補間 (three.js の場面には触らない計算だけ)。
// フレーム f (小数も可) の前後のキーフレームから、回転は球面線形補間、位置と表情は線形補間で求める。
// 最初のキーフレームより前・最後より後は、そのキーフレームの値のまま。片方にしかないボーンは、もう片方を 0 とみなす
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _e = new THREE.Euler();

export function interpolateKeys(keys: Map<number, PoseKey>, f: number): { pose: Map<number, BoneValue>; morphs: Float32Array | null } {
  const frames = [...keys.keys()].sort((a, b) => a - b);
  if (!frames.length) return { pose: new Map(), morphs: null };
  let i = frames.findIndex(k => k > f);
  if (i < 0) i = frames.length;
  const f0 = frames[Math.max(i - 1, 0)], f1 = frames[Math.min(i, frames.length - 1)];
  const k0 = keys.get(f0)!, k1 = keys.get(f1)!;
  const s = f1 > f0 ? Math.min(Math.max((f - f0) / (f1 - f0), 0), 1) : 0;
  const pose = new Map<number, BoneValue>();
  for (const b of new Set([...k0.pose.keys(), ...k1.pose.keys()])) {
    const a = k0.pose.get(b) ?? ZERO_BONE, c = k1.pose.get(b) ?? ZERO_BONE;
    _qa.setFromEuler(_e.set(a.rx * DEG, a.ry * DEG, a.rz * DEG, 'YXZ'));
    _qb.setFromEuler(_e.set(c.rx * DEG, c.ry * DEG, c.rz * DEG, 'YXZ'));
    _e.setFromQuaternion(_qa.slerp(_qb, s), 'YXZ');
    pose.set(b, {
      rx: _e.x / DEG, ry: _e.y / DEG, rz: _e.z / DEG,
      px: a.px + (c.px - a.px) * s, py: a.py + (c.py - a.py) * s, pz: a.pz + (c.pz - a.pz) * s,
    });
  }
  let morphs: Float32Array | null = null;
  if (k0.morphs && k1.morphs) {
    morphs = new Float32Array(k0.morphs.length);
    for (let m = 0; m < morphs.length; m++) morphs[m] = k0.morphs[m] + ((k1.morphs[m] ?? 0) - k0.morphs[m]) * s;
  }
  return { pose, morphs };
}
