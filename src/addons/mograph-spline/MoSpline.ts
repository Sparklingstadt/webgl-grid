import { msg } from '../../core/i18n';
import * as THREE from 'three';
import { int, num } from '../../core/normalize';
import { shapeDef } from '../../core/shapes';
import type { AddonApi, ObjectData } from '../../engine/addons/Addons';
import { isShape, type Obj } from '../../engine/types';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { lineGeometry, trimPolylines, tubeGeometry, type Polyline } from '../cinema4d/splines';
import { boundsOf, simpleSpline, turtleSpline } from './generate';

// --- MoSpline (Cinema 4D の MoSpline + スイープ): 形の物を、伸びる曲線 (太さを付けた管) にする ---
// シンプル (曲がり・ねじれ) とタートル (L-システム)。成長を付けると、時刻に合わせて伸びる。
// 曲線は「スプライン」として、ほかの機能 (スプラインに並べるクローナー・スプライン・エフェクタ) も使える
export interface SplineSettings {
  mode: 'simple' | 'turtle';
  length: number; segments: number; bend: number; twist: number;            // シンプル
  premise: string; rules: string; iterations: number; angle: number; step: number; shrink: number; // タートル
  start: number; end: number;   // 見せる範囲 (長さの割合 0〜1)
  grow: number; growStart: number; // 成長: grow 秒かけて、growStart 秒から伸びる (0 で伸びない)
  radius: number; radiusEnd: number; // 管の太さ (始め・終わり。0 で線)
}
export const SPLINE_DEFAULT: SplineSettings = {
  mode: 'simple', length: 4, segments: 160, bend: 540, twist: 300,
  premise: 'F', rules: 'F=FF-[-F+F+F]+[+F-F-F]', iterations: 3, angle: 22.5, step: 0.12, shrink: 1,
  start: 0, end: 1, grow: 0, growStart: 0, radius: 0.06, radiusEnd: 0.015,
};
// タートルの見本
export const TURTLE_PRESETS: { key: string; name: string; set: Partial<SplineSettings> }[] = [
  { key: 'tree', name: msg('木'), set: { premise: 'F', rules: 'F=FF-[-F+F+F]+[+F-F-F]', iterations: 3, angle: 22.5, step: 0.12, shrink: 1 } },
  { key: 'plant', name: msg('草'), set: { premise: 'X', rules: 'X=F+[[X]-X]-F[-FX]+X; F=FF', iterations: 4, angle: 25, step: 0.06, shrink: 1 } },
  { key: 'tree3d', name: msg('立体の木'), set: { premise: 'A', rules: 'A=F[&+A]////[&+A]////[&+A]', iterations: 5, angle: 28, step: 0.6, shrink: 0.72 } },
  { key: 'koch', name: msg('コッホ曲線'), set: { premise: 'F', rules: 'F=F+F--F+F', iterations: 3, angle: 60, step: 0.06, shrink: 1 } },
];
export function normalizeSpline(o: Partial<SplineSettings> | null | undefined): SplineSettings {
  const d = SPLINE_DEFAULT, s = o ?? {};
  const text = (v: unknown, dv: string, max: number) => (typeof v === 'string' ? v.slice(0, max) : dv);
  return {
    mode: s.mode === 'turtle' ? 'turtle' : 'simple',
    length: num(s.length, d.length, 0.01, 100), segments: int(s.segments, d.segments, 1, 2000), bend: num(s.bend, d.bend, -7200, 7200), twist: num(s.twist, d.twist, -7200, 7200),
    premise: text(s.premise, d.premise, 200), rules: text(s.rules, d.rules, 1000), iterations: int(s.iterations, d.iterations, 0, 8),
    angle: num(s.angle, d.angle, -360, 360), step: num(s.step, d.step, 0.001, 10), shrink: num(s.shrink, d.shrink, 0.1, 2),
    start: num(s.start, d.start, 0, 1), end: num(s.end, d.end, 0, 1), grow: num(s.grow, d.grow, 0, 600), growStart: num(s.growStart, d.growStart, 0, 3600),
    radius: num(s.radius, d.radius, 0, 5), radiusEnd: num(s.radiusEnd, d.radiusEnd, 0, 5),
  };
}

interface State { mesh: THREE.Mesh | THREE.LineSegments; lines: Polyline[]; shown: Polyline[]; sig: string; shapeSig: string }
const NAME = '__mospline';

export class MoSpline {
  private states = new WeakMap<Obj, State>();
  private readonly data: ObjectData<SplineSettings>;
  private readonly settingsOf: (o: Obj) => SplineSettings | null;
  private on = true;
  readonly problems = new WeakMap<Obj, string>();
  private readonly offSource: () => void;

  constructor(private api: AddonApi, private c4d: Cinema4d) {
    this.settingsOf = o => (this.on ? (o.addonData?.[`${api.id}.spline`] as SplineSettings | undefined) ?? null : null);
    this.data = api.addObjectData<SplineSettings>({ key: 'spline', label: 'MoSpline', normalize: raw => normalizeSpline(raw as Partial<SplineSettings>), apply: o => this.rebuild(o) });
    api.onBeforeRender(() => this.sync());
    // 場面での曲線 (いま見えている部分)
    this.offSource = c4d.addSplineSource(o => {
      const st = this.states.get(o);
      if (!st) return null;
      o.node.updateMatrixWorld();
      return st.shown.map(l => l.map(p => p.clone().applyMatrix4(o.node.matrixWorld)));
    });
  }
  off() { this.on = false; this.offSource(); }

  get(o: Obj | null | undefined) { return o ? this.data.get(o) : null; }
  set(o: Obj, patch: Partial<SplineSettings> | null) { this.data.set(o, patch === null ? null : normalizeSpline({ ...this.data.get(o), ...patch })); }
  segments(o: Obj) { return this.states.get(o)?.lines.reduce((n, l) => n + l.length - 1, 0) ?? 0; }

  rebuild(o: Obj) {
    const old = this.states.get(o);
    if (old) { o.node.remove(old.mesh); old.mesh.geometry.dispose(); if (old.mesh instanceof THREE.LineSegments) (old.mesh.material as THREE.Material).dispose(); this.states.delete(o); }
    this.problems.delete(o);
    const s = this.settingsOf(o), src = o.mesh, def = shapeDef(o.s);
    if (!s || !src || !isShape(o)) {
      if (src && !this.c4d.cloner(o)) src.visible = true;
      if (isShape(o)) { Object.assign(o, { h: def.h, hx: def.hx, hz: def.hz }); this.api.engine.world.settle(); }
      this.api.engine.viewport.requestDraw();
      return;
    }
    if (this.c4d.cloner(o)) { this.problems.set(o, msg('クローナーにしている物は、MoSpline にできません')); return; }
    const lines = s.mode === 'turtle' ? turtleSpline(s) : simpleSpline(s);
    const b = boundsOf(lines), r = Math.max(s.radius, s.radiusEnd);
    Object.assign(o, {
      h: Math.max(b.isEmpty() ? 0 : b.max.y + r, 0.05),
      hx: Math.max(b.isEmpty() ? 0 : Math.max(-b.min.x, b.max.x) + r, 0.05), hz: Math.max(b.isEmpty() ? 0 : Math.max(-b.min.z, b.max.z) + r, 0.05),
    });
    src.visible = false;
    const st: State = { mesh: new THREE.Mesh(), lines, shown: [], sig: '', shapeSig: '' };
    st.mesh.name = NAME;
    o.node.add(st.mesh);
    this.states.set(o, st);
    this.show(o);
    this.api.engine.world.settle();
  }

  // いま見せる部分 (成長も入れて)
  private range(s: SplineSettings) {
    const t = this.api.engine.clock.t;
    const g = s.grow > 0 ? Math.min(Math.max((t - s.growStart) / s.grow, 0), 1) : 1;
    return [s.start, s.start + (s.end - s.start) * g];
  }
  private show(o: Obj) {
    const st = this.states.get(o), s = this.settingsOf(o);
    if (!st || !s || !o.mesh) return;
    const [a, b] = this.range(s);
    const sig = `${a.toFixed(4)}|${b.toFixed(4)}|${s.radius}|${s.radiusEnd}`;
    if (sig === st.sig) return;
    st.sig = sig;
    st.shown = trimPolylines(st.lines, a, b);
    const prev = st.mesh;
    const line = s.radius <= 0 && s.radiusEnd <= 0;
    const geometry = line ? lineGeometry(st.shown) : tubeGeometry(st.shown, s.radius, s.radiusEnd, 8);
    const next = line ? new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xffffff })) : new THREE.Mesh(geometry, o.mesh.material);
    next.name = NAME;
    next.castShadow = next.receiveShadow = !line;
    o.node.remove(prev);
    prev.geometry.dispose();
    if (prev instanceof THREE.LineSegments) (prev.material as THREE.Material).dispose();
    o.node.add(next);
    st.mesh = next;
    this.api.engine.viewport.requestDraw();
  }

  // 描く前: 成長 (時刻)・材質を合わせる
  private sync() {
    for (const o of this.api.engine.world.objects) {
      const st = this.states.get(o), s = this.settingsOf(o);
      if (!st || !s || !o.mesh) continue;
      if (this.c4d.cloner(o)) { this.rebuild(o); continue; }
      o.mesh.visible = false;
      if (st.mesh instanceof THREE.Mesh && st.mesh.material !== o.mesh.material) st.mesh.material = o.mesh.material;
      if (s.grow > 0) this.show(o);
    }
  }
}
