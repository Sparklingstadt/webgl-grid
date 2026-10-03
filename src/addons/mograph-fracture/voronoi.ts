import * as THREE from 'three';
import { seededRandom } from '../../core/random';

// --- 分割 (Cinema 4D のボロノイ分割・PolyFX) の形の計算 ---
// 破片 = 中心と、中心から見た三角形の頂点 (と面の向き)。どれも three.js の場面には触らない

export interface Piece { center: THREE.Vector3; positions: Float32Array; normals: Float32Array }
type Poly = THREE.Vector3[];

// 形の三角形 (位置は matrix で写した後)
export function trianglesOf(geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4): Poly[] {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!pos) return [];
  const idx = geometry.index ? Array.from(geometry.index.array) : Array.from({ length: pos.count }, (_, i) => i);
  const v = (i: number) => { const p = new THREE.Vector3().fromBufferAttribute(pos, i); return matrix ? p.applyMatrix4(matrix) : p; };
  const out: Poly[] = [];
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const t = [v(idx[i]), v(idx[i + 1]), v(idx[i + 2])];
    if (new THREE.Vector3().subVectors(t[1], t[0]).cross(new THREE.Vector3().subVectors(t[2], t[0])).lengthSq() > 1e-14) out.push(t);
  }
  return out;
}

// 凸な多面体 (多角形の集まり) を、平面 n·x <= d の側だけ残して切る。切り口はふさぐ
export function clip(polys: Poly[], n: THREE.Vector3, d: number): Poly[] {
  const eps = 1e-7, out: Poly[] = [], cut: THREE.Vector3[] = [];
  for (const poly of polys) {
    const res: THREE.Vector3[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = n.dot(a) - d, db = n.dot(b) - d;
      if (da <= eps) res.push(a);
      if ((da < -eps && db > eps) || (da > eps && db < -eps)) {
        const p = a.clone().lerp(b, da / (da - db));
        res.push(p);
        cut.push(p);
      } else if (Math.abs(da) <= eps) cut.push(a);
    }
    if (res.length >= 3) out.push(res);
  }
  // 切り口: 平面の上の点を、真ん中のまわりの角度で並べた多角形 (外向き = n)
  const pts: THREE.Vector3[] = [];
  for (const p of cut) if (!pts.some(q => q.distanceToSquared(p) < 1e-12)) pts.push(p);
  if (pts.length >= 3) {
    const c = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(pts.length);
    const u = new THREE.Vector3().subVectors(pts[0], c).normalize(), w = new THREE.Vector3().crossVectors(n, u);
    pts.sort((a, b) => Math.atan2(w.dot(b.clone().sub(c)), u.dot(b.clone().sub(c))) < Math.atan2(w.dot(a.clone().sub(c)), u.dot(a.clone().sub(c))) ? 1 : -1);
    out.push(pts);
  }
  return out;
}

// 多角形を三角形にして、破片 (中心から見た位置・面の向き) にする。gap (0〜1) で中心へ縮める
function toPiece(polys: Poly[], gap: number): Piece | null {
  const tris: THREE.Vector3[][] = [];
  for (const p of polys) for (let i = 1; i + 1 < p.length; i++) {
    const t = [p[0], p[i], p[i + 1]];
    if (new THREE.Vector3().subVectors(t[1], t[0]).cross(new THREE.Vector3().subVectors(t[2], t[0])).lengthSq() > 1e-14) tris.push(t); // (つぶれた三角形は捨てる)
  }
  if (!tris.length) return null;
  // 中心: 体積の重心 (ふつうは頂点の平均で十分)
  const center = new THREE.Vector3();
  let n = 0;
  for (const t of tris) for (const v of t) { center.add(v); n++; }
  center.divideScalar(n);
  const k = 1 - Math.min(Math.max(gap, 0), 0.9);
  const positions = new Float32Array(tris.length * 9), normals = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => {
    const nor = new THREE.Vector3().subVectors(t[1], t[0]).cross(new THREE.Vector3().subVectors(t[2], t[0])).normalize();
    t.forEach((v, j) => {
      const p = v.clone().sub(center).multiplyScalar(k);
      p.toArray(positions, i * 9 + j * 3);
      nor.toArray(normals, i * 9 + j * 3);
    });
  });
  return { center, positions, normals };
}

// ボロノイの点: 形の箱の中で、形の中 (凸なので、全部の面の内側) にあるランダムな点。spread: uniform / center (中心に寄せる) / edge (外に寄せる)
export function voronoiSeeds(tris: Poly[], count: number, seed: number, spread = 'uniform'): THREE.Vector3[] {
  const box = new THREE.Box3();
  for (const t of tris) for (const v of t) box.expandByPoint(v);
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const planes = tris.map(t => new THREE.Plane().setFromCoplanarPoints(t[0], t[1], t[2]));
  const inside = (p: THREE.Vector3) => planes.every(pl => pl.distanceToPoint(p) <= 1e-6);
  const rnd = seededRandom(seed), out: THREE.Vector3[] = [];
  const flat = Math.min(size.x, size.y, size.z) < 1e-6; // (平面・円盤は、面の中に点を置く)
  for (let k = 0; k < count * 50 && out.length < count; k++) {
    let x = rnd() - 0.5, y = rnd() - 0.5, z = rnd() - 0.5;
    if (spread === 'center') { const s = rnd() ** 2; x *= s; y *= s; z *= s; }
    if (spread === 'edge') { const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) || 1, s = 0.5 / m * (0.8 + rnd() * 0.2); x *= s; y *= s; z *= s; }
    const p = new THREE.Vector3(c.x + x * size.x, c.y + y * size.y, c.z + z * size.z);
    if (flat || inside(p)) out.push(p);
  }
  return out;
}

// ボロノイ分割 (凸な形)。点ごとに、ほかの点との垂直二等分面で切った残り
export function voronoi(tris: Poly[], seeds: THREE.Vector3[], gap = 0): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < seeds.length; i++) {
    let polys: Poly[] = tris.map(t => t.map(v => v.clone()));
    // 近い点から切る (早く小さくなる)
    const others = seeds.map((s, j) => ({ s, j })).filter(o => o.j !== i).sort((a, b) => a.s.distanceToSquared(seeds[i]) - b.s.distanceToSquared(seeds[i]));
    for (const { s } of others) {
      const n = new THREE.Vector3().subVectors(s, seeds[i]);
      if (n.lengthSq() < 1e-12) continue;
      n.normalize();
      const mid = new THREE.Vector3().addVectors(s, seeds[i]).multiplyScalar(0.5);
      polys = clip(polys, n, n.dot(mid));
      if (!polys.length) break;
    }
    const p = toPiece(polys, gap);
    if (p) out.push(p);
  }
  return out;
}

// PolyFX: 三角形 1 枚ずつを破片にする (多すぎるときは、となりの三角形をまとめる)
export function polyfx(tris: Poly[], max: number, gap = 0): Piece[] {
  const per = Math.max(Math.ceil(tris.length / max), 1), out: Piece[] = [];
  for (let i = 0; i < tris.length; i += per) {
    const p = toPiece(tris.slice(i, i + per), gap);
    if (p) out.push(p);
  }
  return out;
}

// 閉じた形の体積 (テスト用: 破片の体積の合計が、元の形の体積になる)
export function volumeOf(p: Piece) {
  let v = 0;
  for (let i = 0; i < p.positions.length; i += 9) {
    const a = new THREE.Vector3().fromArray(p.positions, i), b = new THREE.Vector3().fromArray(p.positions, i + 3), c = new THREE.Vector3().fromArray(p.positions, i + 6);
    v += a.dot(b.cross(c)) / 6;
  }
  return v;
}
