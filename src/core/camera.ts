import { DEG } from './constants';
import { num } from './normalize';

// --- カメラの物 (Blender のカメラ): 置いた場所・高さから、向き (物の回転) と傾きの方へ写す ---
// 目印 (四角すいの枠) はビューポートだけに出る。置いてあれば、レンダリングはいちばん上のカメラから撮る
export interface CameraSettings {
  fov: number;     // 縦の視野角 (度)
  height: number;  // 高さ (m)
  tiltDeg: number; // 下向きの傾き (度。0 で水平、正で下を向く)
}
export const CAMERA_KIND = 13; // 物の種類の番号 (形・モデル・ライトと重ならない)
export const CAMERA_DEFAULT: CameraSettings = { fov: 35, height: 1.5, tiltDeg: 8 };
export function normalizeCamera(o: Partial<CameraSettings> | null | undefined): CameraSettings {
  const d = CAMERA_DEFAULT, s = o ?? {};
  return { fov: num(s.fov, d.fov, 5, 150), height: num(s.height, d.height, 0.05, 100), tiltDeg: num(s.tiltDeg, d.tiltDeg, -89, 89) };
}
// 写す向き (このページの座標の単位ベクトル)。物の回転 r (ラジアン) で回る。r = 0 では -Z を向く
export function cameraForward(r: number, tiltDeg: number): [number, number, number] {
  const t = tiltDeg * DEG;
  return [-Math.sin(r) * Math.cos(t), -Math.sin(t), -Math.cos(r) * Math.cos(t)];
}
// 向きのベクトルから、物の回転 r と傾き (度) を求める (ビューポートの視点からカメラを置くとき)
export function cameraAim(dx: number, dy: number, dz: number): { r: number; tiltDeg: number } {
  const len = Math.hypot(dx, dy, dz) || 1;
  return { r: Math.atan2(-dx, -dz), tiltDeg: Math.asin(Math.min(Math.max(-dy / len, -1), 1)) / DEG };
}
