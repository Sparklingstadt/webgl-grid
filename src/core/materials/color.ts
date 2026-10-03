import * as THREE from 'three';
import type { Color3 } from './nodes';

// マテリアルの色はリニアな値で持ち、画面 (色の欄) には sRGB の '#rrggbb' で見せる
const _c = new THREE.Color();
export const linearToHex = (c: Color3) => `#${_c.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace).getHexString()}`;
export function hexToLinear(hex: string): Color3 {
  _c.set(hex);
  const out = { r: 0, g: 0, b: 0 };
  _c.getRGB(out, THREE.LinearSRGBColorSpace);
  return [out.r, out.g, out.b];
}
