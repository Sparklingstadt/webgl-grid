import * as THREE from 'three';
import { hex, int, num } from '../../core/normalize';
import type { AddonApi, ObjectData } from '../../engine/addons/Addons';
import { isModel, type Obj } from '../../engine/types';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { lineGeometry, tubeGeometry, type Polyline } from '../cinema4d/splines';

// --- トレーサー (Cinema 4D のトレーサー): 動く物の通った跡を、線か管にする ---
// 跡を取るもの: 物 (クローナーならクローン・MoText なら文字) か、MMD モデルのボーン。
//   経路: フレームごとの位置を覚えて、決めたフレーム数だけ跡を残す (再生・動画のレンダリングで伸びる。飛んだら取り直す)
//   連結: いまの位置どうしを、順に線でつなぐ
// 跡は場面に置き (レンダリングにも写る)、スプラインとしてほかの機能 (スプラインに並べるクローナーなど) も使える
export interface TracerSettings {
  mode: 'paths' | 'connect';
  source: 'auto' | 'bones';
  bones: string;     // ボーンの名前 (、か , で区切る)
  length: number;    // 経路: 残すフレーム数
  radius: number;    // 太さ (0 で線)
  color: string;
  closed: boolean;   // 連結: 最後と最初もつなぐ
}
export const TRACER_DEFAULT: TracerSettings = { mode: 'paths', source: 'auto', bones: '右手首、左手首', length: 45, radius: 0.02, color: '#4fc3ff', closed: false };
export function normalizeTracer(o: Partial<TracerSettings> | null | undefined): TracerSettings {
  const d = TRACER_DEFAULT, s = o ?? {};
  return {
    mode: s.mode === 'connect' ? 'connect' : 'paths', source: s.source === 'bones' ? 'bones' : 'auto',
    bones: typeof s.bones === 'string' ? s.bones.slice(0, 500) : d.bones, length: int(s.length, d.length, 2, 600),
    radius: num(s.radius, d.radius, 0, 2), color: hex(s.color, d.color), closed: s.closed === true,
  };
}

interface State { group: THREE.Group; history: Map<number, THREE.Vector3[]>; last: number | null; lines: Polyline[]; sig: string }

export class Tracer {
  private states = new Map<Obj, State>();
  private readonly data: ObjectData<TracerSettings>;
  private readonly settingsOf: (o: Obj) => TracerSettings | null;
  private readonly offSource: () => void;
  private on = true;

  constructor(private api: AddonApi, c4d: Cinema4d) {
    this.settingsOf = o => (this.on ? (o.addonData?.[`${api.id}.tracer`] as TracerSettings | undefined) ?? null : null);
    this.data = api.addObjectData<TracerSettings>({ key: 'tracer', label: 'トレーサー', normalize: raw => normalizeTracer(raw as Partial<TracerSettings>), apply: o => this.reset(o) });
    api.onBeforeRender(() => this.sync());
    this.offSource = c4d.addSplineSource(o => this.states.get(o)?.lines ?? null);
  }
  off() { this.on = false; this.offSource(); for (const o of [...this.states.keys()]) this.drop(o); }

  get(o: Obj | null | undefined) { return o ? this.data.get(o) : null; }
  set(o: Obj, patch: Partial<TracerSettings> | null) { this.data.set(o, patch === null ? null : normalizeTracer({ ...this.data.get(o), ...patch })); }
  // いまの跡 (場面の折れ線)
  lines(o: Obj) { return this.states.get(o)?.lines ?? []; }
  // 跡を取る点の数
  points(o: Obj) { return this.sample(o).length; }

  // 跡を消して取り直す (設定を変えた・やめた)
  private reset(o: Obj) {
    this.drop(o);
    if (!this.settingsOf(o)) return;
    const group = new THREE.Group();
    group.name = '__tracer';
    this.api.engine.graph.scene.add(group);
    this.states.set(o, { group, history: new Map(), last: null, lines: [], sig: '' });
    this.api.engine.viewport.requestDraw();
  }
  private drop(o: Obj) {
    const st = this.states.get(o);
    if (!st) return;
    this.clear(st);
    this.api.engine.graph.scene.remove(st.group);
    this.states.delete(o);
    this.api.engine.viewport.requestDraw();
  }
  private clear(st: State) {
    for (const c of [...st.group.children]) { st.group.remove(c); (c as THREE.Mesh).geometry.dispose(); ((c as THREE.Mesh).material as THREE.Material).dispose(); }
  }

  // 跡を取る点 (場面の位置)
  private sample(o: Obj): THREE.Vector3[] {
    const s = this.settingsOf(o);
    if (!s) return [];
    o.node.updateMatrixWorld(true);
    if (s.source === 'bones') {
      if (!isModel(o)) return [];
      const names = s.bones.split(/[、,\s]+/).filter(Boolean);
      const bones: THREE.Bone[] = o.model.skeleton.bones;
      return names.map(n => bones.find(b => b.name === n)).filter((b): b is THREE.Bone => !!b).map(b => b.getWorldPosition(new THREE.Vector3()));
    }
    // クローン・MoText の文字があれば、そのひとつずつ
    for (const name of ['__clones', '__motext']) {
      const g = o.node.getObjectByName(name);
      if (g?.children.length) return g.children.map(c => c.getWorldPosition(new THREE.Vector3()));
    }
    return [o.node.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, o.h / 2, 0))];
  }

  // 描く前: いまのフレームの位置を覚えて、跡を作り直す
  private sync() {
    const { world, clock } = this.api.engine;
    for (const o of [...this.states.keys()]) if (!world.has(o) || !this.settingsOf(o)) this.drop(o);
    for (const o of world.objects) {
      const s = this.settingsOf(o);
      if (!s) continue;
      if (!this.states.has(o)) this.reset(o);
      const st = this.states.get(o)!, pts = this.sample(o), f = clock.frame;
      let lines: Polyline[];
      if (s.mode === 'connect') {
        lines = pts.length >= 2 ? [s.closed && pts.length >= 3 ? [...pts, pts[0].clone()] : pts] : [];
      } else {
        // 戻った・飛んだ・点の数が変わったら、取り直す
        const prev = st.last === null ? null : st.history.get(st.last);
        if (st.last !== null && (f < st.last || f > st.last + 1 || (prev && prev.length !== pts.length))) st.history.clear();
        st.history.set(f, pts);
        st.last = f;
        for (const k of st.history.keys()) if (k <= f - s.length) st.history.delete(k);
        const frames = [...st.history.keys()].sort((a, b) => a - b);
        lines = pts.map((_, i) => frames.map(k => st.history.get(k)![i]).filter(Boolean)).filter(l => l.length >= 2);
      }
      st.lines = lines;
      // (跡が変わるのは、いまのフレームの点が変わったときだけ)
      const sig = `${s.mode}|${s.radius}|${s.color}|${s.closed}|${f}|${st.history.size}|${pts.map(p => `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`).join(';')}`;
      if (sig === st.sig) continue;
      st.sig = sig;
      this.clear(st);
      const color = new THREE.Color(s.color);
      // 経路は、古い方を細く (先 (いま) が太い)
      const mesh = s.radius > 0
        ? new THREE.Mesh(tubeGeometry(lines, s.mode === 'paths' ? s.radius * 0.15 : s.radius, s.radius, 6), new THREE.MeshStandardMaterial({ color, roughness: 0.5 }))
        : new THREE.LineSegments(lineGeometry(lines), new THREE.LineBasicMaterial({ color }));
      mesh.raycast = () => {};
      st.group.add(mesh);
    }
  }
}
