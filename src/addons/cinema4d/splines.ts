import * as THREE from 'three';

// --- スプライン (曲線): 点の並び (折れ線) と、それに太さを付けた管 (Cinema 4D のスイープ) ---
// MoSpline・トレーサーが作り、クローナー (スプラインに並べる)・スプライン・エフェクタが使う
export type Polyline = THREE.Vector3[];

export const polylineLength = (p: Polyline) => { let l = 0; for (let i = 1; i < p.length; i++) l += p[i].distanceTo(p[i - 1]); return l; };
const totalLength = (lines: Polyline[]) => lines.reduce((s, l) => s + polylineLength(l), 0);

// 全部の線を続けて見たときの、長さの割合 t (0〜1) の点と向き
export function sampleAlong(lines: Polyline[], t: number): { point: THREE.Vector3; tangent: THREE.Vector3 } | null {
  const total = totalLength(lines);
  const ls = lines.filter(l => l.length >= 2);
  if (!ls.length) return null;
  let d = Math.min(Math.max(t, 0), 1) * total;
  for (const l of ls) {
    for (let i = 1; i < l.length; i++) {
      const seg = l[i].distanceTo(l[i - 1]);
      if (d <= seg || (l === ls[ls.length - 1] && i === l.length - 1)) {
        const u = seg > 0 ? Math.min(d / seg, 1) : 0;
        return { point: l[i - 1].clone().lerp(l[i], u), tangent: l[i].clone().sub(l[i - 1]).normalize() };
      }
      d -= seg;
    }
  }
  return null;
}

// 全部の線を続けて見たときの、長さの割合 start〜end の部分 (成長に使う)
export function trimPolylines(lines: Polyline[], start: number, end: number): Polyline[] {
  const total = totalLength(lines);
  const a = Math.min(Math.max(start, 0), 1) * total, b = Math.min(Math.max(end, 0), 1) * total;
  if (b <= a) return [];
  const out: Polyline[] = [];
  let pos = 0;
  for (const l of lines) {
    const cur: Polyline = [];
    for (let i = 1; i < l.length; i++) {
      const p = l[i - 1], q = l[i], seg = p.distanceTo(q), s0 = pos, s1 = pos + seg;
      pos = s1;
      if (s1 < a || s0 > b || seg === 0) continue;
      const u0 = Math.max((a - s0) / seg, 0), u1 = Math.min((b - s0) / seg, 1);
      if (!cur.length) cur.push(p.clone().lerp(q, u0));
      cur.push(p.clone().lerp(q, u1));
    }
    if (cur.length >= 2) out.push(cur);
  }
  return out;
}

// 折れ線に太さを付けた管 (半径は始めの r0 から終わりの r1 へ。radial: まわりの分け数)。向きは、ねじれないように運ぶ
export function tubeGeometry(lines: Polyline[], r0: number, r1: number, radial = 8): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  for (const line of lines) {
    const pts = line.filter((p, i) => i === 0 || p.distanceToSquared(line[i - 1]) > 1e-12);
    if (pts.length < 2) continue;
    const len = polylineLength(pts);
    const T = pts.map((p, i) => (i === 0 ? pts[1].clone().sub(p) : i === pts.length - 1 ? p.clone().sub(pts[i - 1]) : pts[i + 1].clone().sub(pts[i - 1])).normalize());
    // 最初の横向き: 向きといちばん垂直に近い軸から
    const a = Math.abs(T[0].x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    let Nn = new THREE.Vector3().crossVectors(T[0], a).normalize();
    const base = pos.length / 3;
    let along = 0;
    pts.forEach((p, i) => {
      if (i > 0) {
        along += p.distanceTo(pts[i - 1]);
        // 前の横向きを、向きの変わったぶんだけ回す (平行移動)
        const axis = new THREE.Vector3().crossVectors(T[i - 1], T[i]);
        const s = axis.length();
        if (s > 1e-8) Nn = Nn.applyAxisAngle(axis.divideScalar(s), Math.atan2(s, T[i - 1].dot(T[i]))).normalize();
      }
      const B = new THREE.Vector3().crossVectors(T[i], Nn).normalize();
      const r = r0 + (r1 - r0) * (len > 0 ? along / len : 0);
      for (let k = 0; k <= radial; k++) {
        const ang = k / radial * Math.PI * 2, c = Math.cos(ang), sn = Math.sin(ang);
        const n = new THREE.Vector3().addScaledVector(Nn, c).addScaledVector(B, sn);
        pos.push(p.x + n.x * r, p.y + n.y * r, p.z + n.z * r);
        nor.push(n.x, n.y, n.z);
      }
    });
    for (let i = 0; i + 1 < pts.length; i++) for (let k = 0; k < radial; k++) {
      const a0 = base + i * (radial + 1) + k, b0 = a0 + radial + 1;
      idx.push(a0, b0, a0 + 1, b0, b0 + 1, a0 + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

// 折れ線をそのまま線にする (太さなし)
export function lineGeometry(lines: Polyline[]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const l of lines) for (let i = 1; i < l.length; i++) pos.push(...l[i - 1].toArray(), ...l[i].toArray());
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
}
