import * as THREE from 'three';
import type { Polyline } from '../cinema4d/splines';

// --- MoSpline (Cinema 4D の MoSpline) の曲線の作り方 ---
// どれも物の底面の中心から、上 (+Y) へ伸びる。三角関数の角度は度
const D = Math.PI / 180;
export const MAX_SEGMENTS = 6000;

// シンプル: 長さを分割数に分け、1 つごとに少しずつ曲げ (曲がり)、曲げる向きを回す (ねじれ)。くるくる巻いた線になる
export function simpleSpline(o: { length: number; segments: number; bend: number; twist: number }): Polyline[] {
  const n = Math.min(Math.max(Math.round(o.segments), 1), MAX_SEGMENTS), step = o.length / n;
  const p = new THREE.Vector3(), h = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3(1, 0, 0);
  const out: Polyline = [p.clone()];
  for (let i = 0; i < n; i++) {
    // 曲げる向き (side) を、進む向き (h) のまわりに回してから、side のまわりに h を曲げる
    side.applyAxisAngle(h, o.twist / n * D);
    h.applyAxisAngle(side, o.bend / n * D).normalize();
    p.addScaledVector(h, step);
    out.push(p.clone());
  }
  return [out];
}

// L-システム: 前提 (premise) の記号を、規則 (A=…) で iterations 回書き換える
export function lsystem(premise: string, rules: string, iterations: number, limit = MAX_SEGMENTS * 4) {
  const map = new Map<string, string>();
  for (const line of rules.split(/[\n;,]+/)) {
    const m = /^\s*(\S)\s*[=→:]\s*(.*?)\s*$/.exec(line);
    if (m) map.set(m[1], m[2].replace(/\s+/g, ''));
  }
  let s = premise.replace(/\s+/g, '');
  for (let k = 0; k < Math.min(Math.max(Math.round(iterations), 0), 8); k++) {
    let next = '';
    for (const ch of s) { next += map.get(ch) ?? ch; if (next.length > limit) break; }
    s = next.slice(0, limit);
  }
  return s;
}

// タートル: 記号どおりに亀が歩いた跡を線にする。
//   F G: 進んで描く・f: 進むだけ・+ -: 左右に曲がる・& ^: 下・上に向く・\ /: ひねる・|: 後ろを向く・[ ]: 覚える・戻る (枝)
export function turtleSpline(o: { premise: string; rules: string; iterations: number; angle: number; step: number; shrink: number }): Polyline[] {
  const str = lsystem(o.premise, o.rules, o.iterations);
  const a = o.angle * D;
  let p = new THREE.Vector3(), H = new THREE.Vector3(0, 1, 0), L = new THREE.Vector3(-1, 0, 0), U = new THREE.Vector3(0, 0, 1), len = o.step;
  const stack: { p: THREE.Vector3; H: THREE.Vector3; L: THREE.Vector3; U: THREE.Vector3; len: number }[] = [];
  const out: Polyline[] = [];
  let cur: Polyline = [p.clone()];
  let segments = 0;
  const turn = (axis: THREE.Vector3, ang: number, ...vs: THREE.Vector3[]) => { for (const v of vs) v.applyAxisAngle(axis, ang).normalize(); };
  const flush = () => { if (cur.length >= 2) out.push(cur); };
  for (const ch of str) {
    if (segments >= MAX_SEGMENTS) break;
    switch (ch) {
      case 'F': case 'G': p = p.clone().addScaledVector(H, len); cur.push(p.clone()); segments++; break;
      case 'f': flush(); p = p.clone().addScaledVector(H, len); cur = [p.clone()]; break;
      case '+': turn(U, a, H, L); break;
      case '-': turn(U, -a, H, L); break;
      case '&': turn(L, a, H, U); break;
      case '^': turn(L, -a, H, U); break;
      case '\\': turn(H, a, L, U); break;
      case '/': turn(H, -a, L, U); break;
      case '|': turn(U, Math.PI, H, L); break;
      case '[': stack.push({ p: p.clone(), H: H.clone(), L: L.clone(), U: U.clone(), len }); len *= o.shrink; flush(); cur = [p.clone()]; break;
      case ']': {
        const s = stack.pop();
        if (!s) break;
        flush();
        ({ p, H, L, U, len } = s);
        cur = [p.clone()];
        break;
      }
    }
  }
  flush();
  return out;
}

// 曲線の箱 (足場と高さに使う)
export function boundsOf(lines: Polyline[]) {
  const b = new THREE.Box3();
  for (const l of lines) for (const p of l) b.expandByPoint(p);
  return b;
}
