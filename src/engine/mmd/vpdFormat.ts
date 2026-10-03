import * as THREE from 'three';
import { DEG } from '../constants';
import type { BoneValue } from '../types';

// MMD のポーズファイル (.vpd) の文字列の組み立てと読み取り (three.js の場面には触らない計算だけ)。
// 座標は左手系 (three.js とは z の向きが逆) なので、位置の z と、回転 (クォータニオン) の x・y の符号を反転する。
// ボーンの値は、このページのスライダーと同じ「最初の姿勢からのオイラー角 (度、YXZ の順) と位置のずれ」
export interface VpdPose {
  bones: { name: string; value: BoneValue }[];
  morphs: { name: string; weight: number }[];
}

const _q = new THREE.Quaternion(), _e = new THREE.Euler();
const num = (v: number) => (Math.abs(v) < 5e-7 ? 0 : v).toFixed(6);

export function formatVpd(modelName: string, { bones, morphs }: VpdPose): string {
  const lines = ['Vocaloid Pose Data file', '', `${modelName || 'model'}.osm;\t\t// 親ファイル名`];
  lines.push(`${bones.length};\t\t\t\t// 総ポーズボーン数`, '');
  bones.forEach(({ name, value: v }, n) => {
    const q = _q.setFromEuler(_e.set(v.rx * DEG, v.ry * DEG, v.rz * DEG, 'YXZ'));
    lines.push(`Bone${n}{${name}`,
      `  ${num(v.px)},${num(v.py)},${num(-v.pz)};\t\t\t\t// trans x,y,z`,
      `  ${num(-q.x)},${num(-q.y)},${num(q.z)},${num(q.w)};\t\t// Quaternion x,y,z,w`, '}', '');
  });
  morphs.forEach(({ name, weight }, n) => {
    lines.push(`Morph${n}{${name}`, `  ${num(weight)};\t\t\t\t// weight`, '}', '');
  });
  return lines.join('\r\n');
}

// .vpd でなければ null
export function parseVpd(text: string): VpdPose | null {
  if (!/^Vocaloid Pose Data file/.test(text.trimStart())) return null;
  const n = '([-+0-9.eE]+)';
  const boneRe = new RegExp(`Bone\\d+\\{([^\\r\\n]*)\\s+${n},${n},${n};[^\\n]*\\n\\s*${n},${n},${n},${n};`, 'g');
  const morphRe = new RegExp(`Morph\\d+\\{([^\\r\\n]*)\\s+${n};`, 'g');
  const bones = [...text.matchAll(boneRe)].map(m => {
    const q = _q.set(-m[5], -m[6], +m[7], +m[8]).normalize();
    const e = _e.setFromQuaternion(q, 'YXZ');
    return { name: m[1].trim(), value: { rx: e.x / DEG, ry: e.y / DEG, rz: e.z / DEG, px: +m[2], py: +m[3], pz: -m[4] } };
  });
  const morphs = [...text.matchAll(morphRe)].map(m => ({ name: m[1].trim(), weight: +m[2] }));
  return { bones, morphs };
}

// MMD のファイルは Shift-JIS。UTF-8 として正しく読めるならそちらで読む
export function decodeMmdText(buf: ArrayBuffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('shift_jis').decode(buf); }
}
