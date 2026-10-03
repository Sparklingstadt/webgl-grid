// --- 文字の輪郭: 描いた文字の濃さ (0〜1 の格子) から、なめらかな輪郭の線 (閉じた多角形) を取り出す ---
// マーチングスクエア (濃さ iso の等高線)。輪郭の中に入っている深さで、外側 (偶数) と穴 (奇数) を分ける
export type Pt = [number, number];
export interface Outline { outer: Pt[]; holes: Pt[][] }

// 4 つの角 (左上 8・右上 4・右下 2・左下 1) の内外で、セルを横切る線 (辺の組)。T 上・R 右・B 下・L 左
type E = 'T' | 'R' | 'B' | 'L';
const CASES: Record<number, [E, E][]> = {
  1: [['L', 'B']], 2: [['B', 'R']], 3: [['L', 'R']], 4: [['T', 'R']], 6: [['T', 'B']], 7: [['T', 'L']],
  8: [['T', 'L']], 9: [['T', 'B']], 11: [['T', 'R']], 12: [['L', 'R']], 13: [['B', 'R']], 14: [['L', 'B']],
};

// 濃さ v (w × h、行ごと) の等高線を、閉じた線の集まりにする (外は 0 とみなすので、どれも閉じる)
export function traceLoops(v: ArrayLike<number>, w: number, h: number, iso = 0.5): Pt[][] {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : v[y * w + x]);
  const pts = new Map<string, Pt>();
  const segs: [string, string][] = [];
  const point = (e: E, x: number, y: number): string => {
    // 辺ごとの名前 (となりのセルと同じ点になる) と、濃さで比べた位置
    let id: string, a: number, b: number, p: (t: number) => Pt;
    if (e === 'T') { id = `h${x},${y}`; a = at(x, y); b = at(x + 1, y); p = t => [x + t, y]; }
    else if (e === 'B') { id = `h${x},${y + 1}`; a = at(x, y + 1); b = at(x + 1, y + 1); p = t => [x + t, y + 1]; }
    else if (e === 'L') { id = `v${x},${y}`; a = at(x, y); b = at(x, y + 1); p = t => [x, y + t]; }
    else { id = `v${x + 1},${y}`; a = at(x + 1, y); b = at(x + 1, y + 1); p = t => [x + 1, y + t]; }
    if (!pts.has(id)) pts.set(id, p(Math.min(Math.max((iso - a) / (b - a || 1e-9), 0), 1)));
    return id;
  };
  for (let y = -1; y < h; y++) for (let x = -1; x < w; x++) {
    const tl = at(x, y) >= iso, tr = at(x + 1, y) >= iso, br = at(x + 1, y + 1) >= iso, bl = at(x, y + 1) >= iso;
    const c = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
    let pairs = CASES[c];
    if (c === 5 || c === 10) {
      // 斜めの 2 つだけが中: まん中の濃さで、つながっているかを決める
      const center = (at(x, y) + at(x + 1, y) + at(x + 1, y + 1) + at(x, y + 1)) / 4 >= iso;
      pairs = (c === 5) === center ? [['T', 'L'], ['B', 'R']] : [['T', 'R'], ['L', 'B']];
    }
    for (const [a, b] of pairs ?? []) segs.push([point(a, x, y), point(b, x, y)]);
  }
  // 線分を、点を共有するものどうしでつなぐ
  const by = new Map<string, number[]>();
  segs.forEach(([a, b], i) => { for (const k of [a, b]) { const l = by.get(k); if (l) l.push(i); else by.set(k, [i]); } });
  const used = new Uint8Array(segs.length), loops: Pt[][] = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const loop = [segs[s][0]];
    let cur = segs[s][1];
    for (;;) {
      if (cur === loop[0]) break;
      loop.push(cur);
      const next = (by.get(cur) ?? []).find(i => !used[i]);
      if (next === undefined) break;
      used[next] = 1;
      cur = segs[next][0] === cur ? segs[next][1] : segs[next][0];
    }
    if (loop.length >= 3) loops.push(loop.map(k => pts.get(k)!));
  }
  return loops;
}

export const area = (p: Pt[]) => { let a = 0; for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; } return a / 2; };
export function inside(pt: Pt, poly: Pt[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// 線を間引く (ダグラス・ポイカー。eps より近い点は捨てる)
export function simplify(p: Pt[], eps: number): Pt[] {
  if (p.length < 8) return p;
  const keep = new Uint8Array(p.length);
  const dist = (q: Pt, a: Pt, b: Pt) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1e-9; return Math.abs(dy * q[0] - dx * q[1] + b[0] * a[1] - b[1] * a[0]) / l; };
  const rec = (i: number, j: number) => {
    let m = -1, md = eps;
    for (let k = i + 1; k < j; k++) { const d = dist(p[k], p[i], p[j]); if (d > md) { md = d; m = k; } }
    if (m >= 0) { keep[m] = 1; rec(i, m); rec(m, j); }
  };
  // 閉じた線なので、いちばん遠い 2 点で 2 つに分けてから
  const far = p.reduce((best, q, k) => (Math.hypot(q[0] - p[0][0], q[1] - p[0][1]) > Math.hypot(p[best][0] - p[0][0], p[best][1] - p[0][1]) ? k : best), 0);
  keep[0] = keep[far] = 1;
  rec(0, far);
  rec(far, p.length - 1);
  keep[p.length - 1] = 1;
  const out = p.filter((_, k) => keep[k]);
  return out.length >= 3 ? out : p;
}

// 輪郭の線を、外側と穴に分ける (入っている深さが偶数なら外側、奇数なら穴。穴はすぐ外の外側に付ける)
export function nest(loops: Pt[][], minArea = 0.5): Outline[] {
  const ls = loops.filter(l => Math.abs(area(l)) >= minArea);
  const depth = ls.map(l => ls.filter(o => o !== l && Math.abs(area(o)) > Math.abs(area(l)) && inside(l[0], o)).length);
  const outs: Outline[] = [];
  const outerIdx: number[] = [];
  ls.forEach((l, i) => { if (depth[i] % 2 === 0) { outs.push({ outer: l, holes: [] }); outerIdx.push(i); } });
  ls.forEach((l, i) => {
    if (depth[i] % 2 === 0) return;
    // すぐ外の外側 (深さが 1 つ浅く、自分を含むもののうち一番小さい)
    let best = -1;
    outerIdx.forEach((oi, k) => { if (depth[oi] === depth[i] - 1 && inside(l[0], ls[oi]) && (best < 0 || Math.abs(area(ls[oi])) < Math.abs(area(outs[best].outer)))) best = k; });
    if (best >= 0) outs[best].holes.push(l);
  });
  return outs;
}
