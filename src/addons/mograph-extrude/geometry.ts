import * as THREE from 'three';

// --- MoExtrude の形の計算 (three.js の場面には触らない) ---
// 三角形の面を、同じ向きでつながった「面」(四角形など) にまとめ、面ごとに法線の向きへ押し出す。
// 押し出した先の面 (ふた) と、まわりの壁 (段の数だけ) を作る。元の面は、押し出すと内側に隠れるので作らない
export interface Face {
  tris: [number, number, number][];   // 頂点の番号 (verts)
  boundary: [number, number][];       // まわりの辺 (向きはふたと同じ回り)
  center: THREE.Vector3;
  normal: THREE.Vector3;
}

// 三角形を面にまとめる (頂点は位置で同じものとみなす)
export function facesOf(tris: THREE.Vector3[][]): { verts: THREE.Vector3[]; faces: Face[] } {
  const verts: THREE.Vector3[] = [], index = new Map<string, number>();
  const id = (p: THREE.Vector3) => {
    const k = `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`;
    let i = index.get(k);
    if (i === undefined) { index.set(k, i = verts.length); verts.push(p.clone()); }
    return i;
  };
  const t = tris.map(tr => [id(tr[0]), id(tr[1]), id(tr[2])] as [number, number, number]);
  const normals = tris.map(tr => new THREE.Vector3().subVectors(tr[1], tr[0]).cross(new THREE.Vector3().subVectors(tr[2], tr[0])));
  const areas = normals.map(n => n.length());
  normals.forEach(n => n.normalize());
  // 辺を共有して同じ向きの三角形を、まとめる (union-find)
  const parent = t.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const byEdge = new Map<string, number[]>();
  const ek = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  t.forEach(([a, b, c], i) => { for (const [x, y] of [[a, b], [b, c], [c, a]]) { const k = ek(x, y); byEdge.set(k, [...(byEdge.get(k) ?? []), i]); } });
  for (const list of byEdge.values()) {
    for (let i = 1; i < list.length; i++) if (areas[list[0]] && areas[list[i]] && normals[list[0]].dot(normals[list[i]]) > 0.999) parent[root(list[i])] = root(list[0]);
  }
  const groups = new Map<number, number[]>();
  t.forEach((_, i) => { if (areas[i] > 1e-12) groups.set(root(i), [...(groups.get(root(i)) ?? []), i]); });
  const faces: Face[] = [];
  for (const members of groups.values()) {
    const count = new Map<string, number>();
    for (const i of members) { const [a, b, c] = t[i]; for (const [x, y] of [[a, b], [b, c], [c, a]]) count.set(ek(x, y), (count.get(ek(x, y)) ?? 0) + 1); }
    const boundary: [number, number][] = [];
    for (const i of members) { const [a, b, c] = t[i]; for (const [x, y] of [[a, b], [b, c], [c, a]] as [number, number][]) if (count.get(ek(x, y)) === 1) boundary.push([x, y]); }
    const used = [...new Set(members.flatMap(i => t[i]))];
    const center = used.reduce((s, i) => s.add(verts[i]), new THREE.Vector3()).divideScalar(used.length);
    const normal = members.reduce((s, i) => s.addScaledVector(normals[i], areas[i]), new THREE.Vector3()).normalize();
    faces.push({ tris: members.map(i => t[i]), boundary, center, normal });
  }
  return { verts, faces };
}

// 頂点の数 (面の並びが同じなら、押し出す長さを変えても同じ)
export const vertexCount = (faces: Face[], steps: number) => faces.reduce((n, f) => n + f.tris.length * 3 + f.boundary.length * steps * 6, 0);

// 押し出した形の頂点と法線 (面ごとの平らな陰)。amount[i] は面 i を押し出す長さ、shift[i] はふたのずれ、capScale はふたの大きさ
export function extrude(verts: THREE.Vector3[], faces: Face[], amount: number[], shift: THREE.Vector3[], capScale: number, steps: number,
                        out?: { positions: Float32Array; normals: Float32Array }) {
  const n = vertexCount(faces, steps);
  const P = out?.positions ?? new Float32Array(n * 3), N = out?.normals ?? new Float32Array(n * 3);
  let k = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nn = new THREE.Vector3(), mid = new THREE.Vector3();
  const tri = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, outward?: THREE.Vector3) => {
    nn.subVectors(p1, p0).cross(c.subVectors(p2, p0)).normalize();
    let q1 = p1, q2 = p2;
    // (壁は、面の真ん中から外へ向くように回りをそろえる)
    if (outward && nn.dot(mid.addVectors(p0, p1).add(p2).divideScalar(3).sub(outward)) < 0) { q1 = p2; q2 = p1; nn.negate(); }
    for (const p of [p0, q1, q2]) { P[k] = p.x; P[k + 1] = p.y; P[k + 2] = p.z; N[k] = nn.x; N[k + 1] = nn.y; N[k + 2] = nn.z; k += 3; }
  };
  // 頂点 v を、面 f のふたの位置へ (t = 0: 元の位置、1: ふた)
  const lift = (v: THREE.Vector3, f: Face, i: number, t: number, to: THREE.Vector3) => {
    const s = 1 + (capScale - 1) * t;
    return to.copy(v).sub(f.center).multiplyScalar(s).add(f.center).addScaledVector(f.normal, amount[i] * t).addScaledVector(shift[i], t);
  };
  const v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
  faces.forEach((f, i) => {
    for (const [x, y, z] of f.tris) tri(lift(verts[x], f, i, 1, v0), lift(verts[y], f, i, 1, v1), lift(verts[z], f, i, 1, v2));
    for (const [x, y] of f.boundary) {
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps, t1 = (s + 1) / steps;
        lift(verts[x], f, i, t0, v0); lift(verts[y], f, i, t0, v1); lift(verts[y], f, i, t1, v2); lift(verts[x], f, i, t1, v3);
        const center = a.copy(f.center).addScaledVector(f.normal, amount[i] * (t0 + t1) / 2).addScaledVector(shift[i], (t0 + t1) / 2);
        tri(v0, v1, v2, center);
        tri(v0, v2, v3, b.copy(center));
      }
    }
  });
  return { positions: P, normals: N };
}
