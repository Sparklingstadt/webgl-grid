// three.js (右手系) ⇔ MMD (左手系) の座標と、D3D の行列。
// 行列はすべて three.js の Matrix4 (列ベクトルの書き方)。elements (列ごとの並び) は
// そのまま D3D の「行ごとの並び」になるので、コンパイル済みのシェーダー (mul(v, M)) に素通しで渡せる。
import { Matrix4, Vector3 } from 'three';

// z を反転する行列 S = diag(1, 1, −1)
const S = new Matrix4().makeScale(1, 1, -1);

// 右手系の行列を左手系に直す (S·m·S)。新しい行列を返す
export function toMmd(m: Matrix4): Matrix4 {
  return new Matrix4().multiplyMatrices(S, m).multiply(S);
}

export function toMmdVec(v: Vector3): Vector3 {
  return new Vector3(v.x, v.y, -v.z);
}

// 左手系の世界 → 視野。視野では視線が +z、上が +y、右が +x (D3DXMatrixLookAtLH)
export function viewLH(eye: Vector3, target: Vector3, up: Vector3): Matrix4 {
  const z = new Vector3().subVectors(target, eye).normalize();
  const x = new Vector3().crossVectors(up, z).normalize();
  const y = new Vector3().crossVectors(z, x);
  return new Matrix4().set(
    x.x, x.y, x.z, -x.dot(eye),
    y.x, y.y, y.z, -y.dot(eye),
    z.x, z.y, z.z, -z.dot(eye),
    0, 0, 0, 1,
  );
}

// 視野の z を [near, far] → NDC の z を [0, 1] (D3DXMatrixPerspectiveFovLH)
export function perspectiveD3D(fovY: number, aspect: number, near: number, far: number): Matrix4 {
  const ys = 1 / Math.tan(fovY / 2);
  const xs = ys / aspect;
  const q = far / (far - near);
  return new Matrix4().set(
    xs, 0, 0, 0,
    0, ys, 0, 0,
    0, 0, q, -near * q,
    0, 0, 1, 0,
  );
}

// 正射影。z は [near, far] → [0, 1] (D3DXMatrixOrthoOffCenterLH)
export function orthoD3D(left: number, right: number, bottom: number, top: number, near: number, far: number): Matrix4 {
  return new Matrix4().set(
    2 / (right - left), 0, 0, (left + right) / (left - right),
    0, 2 / (top - bottom), 0, (top + bottom) / (bottom - top),
    0, 0, 1 / (far - near), near / (near - far),
    0, 0, 0, 1,
  );
}

// lightDir.y がこれより 0 に近い (または上向き) と影が無限に伸びるので、−MIN_LIGHT_Y に丸める
const MIN_LIGHT_Y = 1e-3;
// 地面の影が地面と重ならないよう持ち上げる高さ
const SHADOW_LIFT = 0.01;

// lightDir (光が進む向き、左手系) に沿って y の高さの面へ潰し、さらに 0.01 持ち上げる行列。
// 向きは正規化されていなくてよい
export function groundShadowMatrix(lightDir: Vector3, y = 0): Matrix4 {
  const ly = Math.min(lightDir.y, -MIN_LIGHT_Y);
  const kx = lightDir.x / ly, kz = lightDir.z / ly;
  // p' = p + t·L、p'.y = y となる t = (y − p.y) / L.y
  return new Matrix4().set(
    1, -kx, 0, kx * y,
    0, 0, 0, y + SHADOW_LIFT,
    0, -kz, 1, kz * y,
    0, 0, 0, 1,
  );
}
