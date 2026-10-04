// MMD と同じ CPU の変形 (BDEF・SDEF・QDEF)・頂点モーフ・輪郭線の広げ方。
// 位置・法線・行列はすべて左手系。毎フレーム呼ぶので、頂点ごとのループの中では何も作らない。

export const SKIN = { BDEF1: 0, BDEF2: 1, BDEF4: 2, SDEF: 3, QDEF: 4 } as const;

export interface SkinData {
  count: number;
  type: Uint8Array; // 頂点ごとの SKIN の値
  bones: Int32Array; // 頂点ごとに 4 つ (使わない所は 0)
  weights: Float32Array; // 頂点ごとに 4 つ
  sdef: Float32Array; // 頂点ごとに 9 つ (C, R0, R1。左手系)。SDEF 以外は 0
}

// base + Σ 重み × 差分。deltas と weights は同じ数。out は base と同じ配列でもよい
export function applyMorphs(base: Float32Array, deltas: Float32Array[], weights: ArrayLike<number>, out: Float32Array): void {
  if (out !== base) out.set(base);
  for (let m = 0; m < deltas.length; m++) {
    const w = weights[m];
    if (w === 0) continue;
    const d = deltas[m];
    for (let i = 0; i < d.length; i++) out[i] += d[i] * w;
  }
}

// 骨ごとの回転の四元数 (x, y, z, w)。列の長さで割って拡縮を除いてから取り出す。skin() の呼び出しごとに SDEF があるときだけ作る
let boneQuat = new Float32Array(0);

function computeBoneQuats(bones: Float32Array, boneCount: number): void {
  if (boneQuat.length < boneCount * 4) boneQuat = new Float32Array(boneCount * 4);
  for (let b = 0; b < boneCount; b++) {
    const o = b * 16, q = b * 4;
    const l0 = Math.hypot(bones[o], bones[o + 1], bones[o + 2]) || 1;
    const l1 = Math.hypot(bones[o + 4], bones[o + 5], bones[o + 6]) || 1;
    const l2 = Math.hypot(bones[o + 8], bones[o + 9], bones[o + 10]) || 1;
    // r(行, 列) = bones[列 × 4 + 行] / 列の長さ
    const m11 = bones[o] / l0, m21 = bones[o + 1] / l0, m31 = bones[o + 2] / l0;
    const m12 = bones[o + 4] / l1, m22 = bones[o + 5] / l1, m32 = bones[o + 6] / l1;
    const m13 = bones[o + 8] / l2, m23 = bones[o + 9] / l2, m33 = bones[o + 10] / l2;
    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      boneQuat[q + 3] = 0.25 / s;
      boneQuat[q] = (m32 - m23) * s;
      boneQuat[q + 1] = (m13 - m31) * s;
      boneQuat[q + 2] = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
      boneQuat[q + 3] = (m32 - m23) / s;
      boneQuat[q] = 0.25 * s;
      boneQuat[q + 1] = (m12 + m21) / s;
      boneQuat[q + 2] = (m13 + m31) / s;
    } else if (m22 > m33) {
      const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
      boneQuat[q + 3] = (m13 - m31) / s;
      boneQuat[q] = (m12 + m21) / s;
      boneQuat[q + 1] = 0.25 * s;
      boneQuat[q + 2] = (m23 + m32) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
      boneQuat[q + 3] = (m21 - m12) / s;
      boneQuat[q] = (m13 + m31) / s;
      boneQuat[q + 1] = (m23 + m32) / s;
      boneQuat[q + 2] = 0.25 * s;
    }
  }
}

// bones: 骨ごとの変形の行列 (列ベクトルの書き方の elements、16 個ずつ)。
// 法線は 3×3 だけで回す (MMD の骨の変形は剛体なので逆転置は要らない)。重みの合計が 0 の頂点は入力をそのまま写す
export function skin(data: SkinData, positions: Float32Array, normals: Float32Array, bones: Float32Array, outPos: Float32Array, outNrm: Float32Array): void {
  const { count, type, weights, sdef } = data;
  const boneIdx = data.bones;

  let hasSdef = false;
  for (let v = 0; v < count; v++) if (type[v] === SKIN.SDEF) { hasSdef = true; break; }
  if (hasSdef) computeBoneQuats(bones, bones.length / 16);

  for (let v = 0; v < count; v++) {
    const i3 = v * 3, i4 = v * 4;
    const px = positions[i3], py = positions[i3 + 1], pz = positions[i3 + 2];
    const nx = normals[i3], ny = normals[i3 + 1], nz = normals[i3 + 2];
    const t = type[v];

    if (t === SKIN.SDEF) {
      const w0 = weights[i4], w1 = weights[i4 + 1];
      if (w0 + w1 === 0) {
        outPos[i3] = px; outPos[i3 + 1] = py; outPos[i3 + 2] = pz;
        outNrm[i3] = nx; outNrm[i3 + 1] = ny; outNrm[i3 + 2] = nz;
        continue;
      }
      const o0 = boneIdx[i4] * 16, o1 = boneIdx[i4 + 1] * 16;
      const q0 = boneIdx[i4] * 4, q1 = boneIdx[i4 + 1] * 4;
      const s = v * 9;
      const cx = sdef[s], cy = sdef[s + 1], cz = sdef[s + 2];
      const r0x = sdef[s + 3], r0y = sdef[s + 4], r0z = sdef[s + 5];
      const r1x = sdef[s + 6], r1y = sdef[s + 7], r1z = sdef[s + 8];
      // rw = R0 w0 + R1 w1、r0 = C + R0 − rw、r1 = C + R1 − rw、cr = (C + r) / 2
      const rwx = r0x * w0 + r1x * w1, rwy = r0y * w0 + r1y * w1, rwz = r0z * w0 + r1z * w1;
      const cr0x = cx + (r0x - rwx) * 0.5, cr0y = cy + (r0y - rwy) * 0.5, cr0z = cz + (r0z - rwz) * 0.5;
      const cr1x = cx + (r1x - rwx) * 0.5, cr1y = cy + (r1y - rwy) * 0.5, cr1z = cz + (r1z - rwz) * 0.5;

      // slerp(q0, q1, w1)。内積が負なら q1 を反転
      const ax = boneQuat[q0], ay = boneQuat[q0 + 1], az = boneQuat[q0 + 2], aw = boneQuat[q0 + 3];
      let bx = boneQuat[q1], by = boneQuat[q1 + 1], bz = boneQuat[q1 + 2], bw = boneQuat[q1 + 3];
      let dot = ax * bx + ay * by + az * bz + aw * bw;
      if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
      let ka: number, kb: number;
      if (dot > 0.9995) {
        // ほぼ同じ向きは線形で補う (sin が 0 に近いので)
        ka = 1 - w1; kb = w1;
      } else {
        const theta = Math.acos(dot), sinT = Math.sin(theta);
        ka = Math.sin((1 - w1) * theta) / sinT;
        kb = Math.sin(w1 * theta) / sinT;
      }
      let qx = ax * ka + bx * kb, qy = ay * ka + by * kb, qz = az * ka + bz * kb, qw = aw * ka + bw * kb;
      const ql = Math.hypot(qx, qy, qz, qw) || 1;
      qx /= ql; qy /= ql; qz /= ql; qw /= ql;

      // rotate(q, v) = v + 2 (w (u × v) + u × (u × v))、u = q.xyz
      let dx = px - cx, dy = py - cy, dz = pz - cz;
      let tx = qy * dz - qz * dy, ty = qz * dx - qx * dz, tz = qx * dy - qy * dx; // u × d
      let rx = dx + 2 * (qw * tx + qy * tz - qz * ty);
      let ry = dy + 2 * (qw * ty + qz * tx - qx * tz);
      let rz = dz + 2 * (qw * tz + qx * ty - qy * tx);
      // + M0 · cr0 × w0 + M1 · cr1 × w1 (w = 1)
      rx += (bones[o0] * cr0x + bones[o0 + 4] * cr0y + bones[o0 + 8] * cr0z + bones[o0 + 12]) * w0
        + (bones[o1] * cr1x + bones[o1 + 4] * cr1y + bones[o1 + 8] * cr1z + bones[o1 + 12]) * w1;
      ry += (bones[o0 + 1] * cr0x + bones[o0 + 5] * cr0y + bones[o0 + 9] * cr0z + bones[o0 + 13]) * w0
        + (bones[o1 + 1] * cr1x + bones[o1 + 5] * cr1y + bones[o1 + 9] * cr1z + bones[o1 + 13]) * w1;
      rz += (bones[o0 + 2] * cr0x + bones[o0 + 6] * cr0y + bones[o0 + 10] * cr0z + bones[o0 + 14]) * w0
        + (bones[o1 + 2] * cr1x + bones[o1 + 6] * cr1y + bones[o1 + 10] * cr1z + bones[o1 + 14]) * w1;
      outPos[i3] = rx; outPos[i3 + 1] = ry; outPos[i3 + 2] = rz;

      // 法線は q で回すだけ
      tx = qy * nz - qz * ny; ty = qz * nx - qx * nz; tz = qx * ny - qy * nx;
      outNrm[i3] = nx + 2 * (qw * tx + qy * tz - qz * ty);
      outNrm[i3 + 1] = ny + 2 * (qw * ty + qz * tx - qx * tz);
      outNrm[i3 + 2] = nz + 2 * (qw * tz + qx * ty - qy * tx);
      continue;
    }

    // BDEF1 は骨 1 本・重み 1。BDEF2・BDEF4・QDEF (BDEF4 として) は 4 本分を重みで混ぜる
    const n = t === SKIN.BDEF1 ? 1 : 4;
    let x = 0, y = 0, z = 0, gx = 0, gy = 0, gz = 0, sum = 0;
    for (let k = 0; k < n; k++) {
      const w = n === 1 ? 1 : weights[i4 + k];
      if (w === 0) continue;
      const o = boneIdx[i4 + k] * 16;
      sum += w;
      x += (bones[o] * px + bones[o + 4] * py + bones[o + 8] * pz + bones[o + 12]) * w;
      y += (bones[o + 1] * px + bones[o + 5] * py + bones[o + 9] * pz + bones[o + 13]) * w;
      z += (bones[o + 2] * px + bones[o + 6] * py + bones[o + 10] * pz + bones[o + 14]) * w;
      gx += (bones[o] * nx + bones[o + 4] * ny + bones[o + 8] * nz) * w;
      gy += (bones[o + 1] * nx + bones[o + 5] * ny + bones[o + 9] * nz) * w;
      gz += (bones[o + 2] * nx + bones[o + 6] * ny + bones[o + 10] * nz) * w;
    }
    if (sum === 0) {
      outPos[i3] = px; outPos[i3 + 1] = py; outPos[i3 + 2] = pz;
      outNrm[i3] = nx; outNrm[i3 + 1] = ny; outNrm[i3 + 2] = nz;
      continue;
    }
    outPos[i3] = x; outPos[i3 + 1] = y; outPos[i3 + 2] = z;
    const gl = Math.hypot(gx, gy, gz);
    if (gl > 0) {
      outNrm[i3] = gx / gl; outNrm[i3 + 1] = gy / gl; outNrm[i3 + 2] = gz / gl;
    } else {
      outNrm[i3] = nx; outNrm[i3 + 1] = ny; outNrm[i3 + 2] = nz;
    }
  }
}

// 位置 + 法線 × (太さ / 300) × (eye から位置までの距離) × tanHalfFovY。eye は物の空間のカメラの位置
export function expandEdges(pos: Float32Array, nrm: Float32Array, edgeSize: Float32Array, eye: [number, number, number], tanHalfFovY: number, out: Float32Array): void {
  const ex = eye[0], ey = eye[1], ez = eye[2];
  const count = edgeSize.length;
  for (let v = 0; v < count; v++) {
    const i = v * 3;
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    const k = (edgeSize[v] / 300) * Math.hypot(ex - x, ey - y, ez - z) * tanHalfFovY;
    out[i] = x + nrm[i] * k;
    out[i + 1] = y + nrm[i + 1] * k;
    out[i + 2] = z + nrm[i + 2] * k;
  }
}
