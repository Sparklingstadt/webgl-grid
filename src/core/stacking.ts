// 積み重ねの計算 (three.js の場面には触らない計算だけ)

// 上から見た足場: 中心 (x, z)、縦軸まわりの回転 r、回転前の半分の幅 hx / hz
export interface Footprint { x: number; z: number; r: number; hx: number; hz: number }
// 積める物: 足場と、積み重ねで決まる高さ y と、自分の高さ h
export interface Stackable extends Footprint { y: number; h: number }

export const topOf = (b: Stackable) => b.y + b.h; // 上に載せられる高さ
export const radiusOf = (b: { hx: number; hz: number }) => Math.hypot(b.hx, b.hz);

// 上から見て足場が重なっているか (回転した長方形どうしを分離軸判定で調べる)
export function overlaps(a: Footprint, b: Footprint) {
  const e = 0.0005; // 辺がちょうど接しているだけなら重なりとしない
  const axes = (r: number) => [[Math.cos(r), -Math.sin(r)], [Math.sin(r), Math.cos(r)]];
  const aa = axes(a.r), ba = axes(b.r);
  const d = [b.x - a.x, b.z - a.z];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1];
  for (const u of [...aa, ...ba]) {
    const ra = (a.hx - e) * Math.abs(dot(u, aa[0])) + (a.hz - e) * Math.abs(dot(u, aa[1]));
    const rb = (b.hx - e) * Math.abs(dot(u, ba[0])) + (b.hz - e) * Math.abs(dot(u, ba[1]));
    if (Math.abs(dot(d, u)) >= ra + rb) return false;
  }
  return true;
}

// b の上に (直接または間接的に) 載っている物と b 自身
export function stackFrom<T extends Stackable>(list: T[], b: T): T[] {
  const group = [b];
  for (let i = 0; i < group.length; i++) {
    const s = group[i];
    for (const o of list) {
      if (!group.includes(o) && overlaps(o, s) && Math.abs(o.y - topOf(s)) < 1e-3) group.push(o);
    }
  }
  return group;
}

// 重力: 下にあるものから順に、足場の一番高い所まで落とす (y を書き換える。exclude は動かさない)
export function settleHeights<T extends Stackable>(list: T[], exclude: T[] = []) {
  const placed: T[] = [];
  for (const b of list.filter(b => !exclude.includes(b)).sort((a, b) => a.y - b.y)) {
    b.y = Math.max(0, ...placed.filter(o => overlaps(o, b)).map(topOf));
    placed.push(b);
  }
}

// (cx, cz) に近い、ほかの物と重ならないマス目を探す (半径 rad の物を置く)。内側の輪から順に見る
export function freeSpot(list: Footprint[], rad: number, cx: number, cz: number): [number, number] {
  const free = (x: number, z: number) => list.every(b => Math.max(Math.abs(b.x - x), Math.abs(b.z - z)) >= radiusOf(b) + rad + 0.1);
  for (let r = 0; r < 40; r++) {
    for (let i = -r; i <= r; i++) {
      for (const [x, z] of [[cx + i, cz - r], [cx + i, cz + r], [cx - r, cz + i], [cx + r, cz + i]]) {
        if (free(x, z)) return [x, z];
      }
    }
  }
  return [cx, cz];
}
