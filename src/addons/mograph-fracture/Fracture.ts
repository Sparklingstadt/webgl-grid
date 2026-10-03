import * as THREE from 'three';
import { int, num } from '../../core/normalize';
import type { AddonApi, ObjectData } from '../../engine/addons/Addons';
import { isShape, type Obj } from '../../engine/types';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { normalizeEffectors, type Effector, type Placement } from '../cinema4d/cloner';
import { applyEffectors, hasLive } from '../cinema4d/effectors';
import { polyfx, trianglesOf, voronoi, voronoiSeeds, type Piece } from './voronoi';

// --- 分割 (Cinema 4D のボロノイ分割・PolyFX): 形を破片に分け、エフェクタで動かす ---
// 破片は 1 つのメッシュにまとめ (描くのは 1 回)、置き場所が変わったら頂点を書き直す。
// 元の形は隠す (元に戻すと出す)。デフォーマで変えた形も分ける
export type FractureMode = 'voronoi' | 'polyfx';
export interface FractureSettings {
  mode: FractureMode;
  count: number;   // 破片の数 (ボロノイ)・まとめる前の上限 (PolyFX)
  seed: number;
  spread: 'uniform' | 'center' | 'edge'; // ボロノイの点の散らばり方
  gap: number;     // すき間 (破片を中心へ縮める 0〜0.9)
  effectors: Effector[];
}
export const FRACTURE_DEFAULT: FractureSettings = { mode: 'voronoi', count: 12, seed: 1, spread: 'uniform', gap: 0.02, effectors: [] };
export const MAX_PIECES = 200;
export function normalizeFracture(o: Partial<FractureSettings> | null | undefined): FractureSettings {
  const d = FRACTURE_DEFAULT, s = o ?? {};
  return {
    mode: s.mode === 'polyfx' ? 'polyfx' : 'voronoi', count: int(s.count, d.count, 1, MAX_PIECES), seed: int(s.seed, d.seed, 0, 1e9),
    spread: s.spread === 'center' || s.spread === 'edge' ? s.spread : 'uniform', gap: num(s.gap, d.gap, 0, 0.9), effectors: normalizeEffectors(s.effectors),
  };
}

interface State { mesh: THREE.Mesh; pieces: Piece[]; src: THREE.BufferGeometry; sig: string }
const NAME = '__fracture';

// 形が凸か (三角形の面の内側に、全部の頂点がある)
function convex(tris: THREE.Vector3[][]) {
  const pts = tris.flat();
  return tris.every(t => { const pl = new THREE.Plane().setFromCoplanarPoints(t[0], t[1], t[2]); return pts.every(p => pl.distanceToPoint(p) <= 1e-4); });
}

export class Fracture {
  private states = new WeakMap<Obj, State>();
  private readonly data: ObjectData<FractureSettings>;
  private readonly settingsOf: (o: Obj) => FractureSettings | null;
  private readonly offs: (() => void)[];
  private on = true;
  readonly problems = new WeakMap<Obj, string>(); // 分けられないわけ (パネルに出す)

  constructor(private api: AddonApi, private c4d: Cinema4d) {
    const value = (o: Obj) => (this.on ? (o.addonData?.[`${api.id}.fracture`] as FractureSettings | undefined) ?? null : null);
    this.settingsOf = value;
    this.data = api.addObjectData<FractureSettings>({
      key: 'fracture', label: '分割', normalize: raw => normalizeFracture(raw as Partial<FractureSettings>), apply: o => this.rebuild(o),
    });
    api.onBeforeRender(() => this.sync());
    // エフェクタの種類が増減したら並べ直す。フィールドの枠も出すよう、エフェクタを Cinema 4D に知らせる
    const offReg = c4d.events.on('registry', () => { for (const o of api.engine.world.objects) if (this.states.has(o)) this.place(o); });
    const offSrc = c4d.addEffectorSource(o => value(o)?.effectors ?? null);
    api.addMenuItem({ menu: 'object', label: '分割する / やめる (ボロノイ)', enabled: () => isShape(api.engine.selection.current), run: () => { const o = api.engine.selection.current; if (o) this.set(o, this.get(o) ? null : {}); } });
    this.offs = [offReg, offSrc];
  }
  off() { this.on = false; for (const f of this.offs) f(); }

  get(o: Obj | null | undefined) { return o ? this.data.get(o) : null; }
  // 分割する・設定を変える (patch は今の設定に重ねる。null でやめる)
  set(o: Obj, patch: Partial<FractureSettings> | null) {
    this.data.set(o, patch === null ? null : normalizeFracture({ ...this.data.get(o), ...patch }));
  }
  count(o: Obj | null | undefined) { return o ? this.states.get(o)?.pieces.length ?? 0 : 0; }

  // 破片を作り直す (設定がなければ、元の形に戻す)
  rebuild(o: Obj) {
    const old = this.states.get(o);
    if (old) { o.node.remove(old.mesh); old.mesh.geometry.dispose(); this.states.delete(o); }
    this.problems.delete(o);
    const s = this.settingsOf(o), src = o.mesh;
    if (!s || !src || !isShape(o)) { if (src && !this.c4d.cloner(o)) src.visible = true; this.api.engine.viewport.requestDraw(); return; }
    if (this.c4d.cloner(o)) { this.problems.set(o, 'クローナーにしている物は分割できません (クローナーをやめると分割します)'); return; }
    src.updateMatrix();
    const tris = trianglesOf(src.geometry, src.matrix);
    let pieces: Piece[] = [];
    if (s.mode === 'polyfx') pieces = polyfx(tris, Math.min(Math.max(s.count, tris.length > MAX_PIECES ? MAX_PIECES : tris.length), MAX_PIECES), s.gap);
    else if (!convex(tris)) this.problems.set(o, 'この形は凸でないので、ボロノイ分割はできません (PolyFX は使えます)');
    else pieces = voronoi(tris, voronoiSeeds(tris, s.count, s.seed, s.spread), s.gap);
    if (!pieces.length) { src.visible = true; this.api.engine.viewport.requestDraw(); return; }
    // 破片を 1 つのメッシュに
    const n = pieces.reduce((a, p) => a + p.positions.length, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n), 3).setUsage(THREE.DynamicDrawUsage));
    const mesh = new THREE.Mesh(g, src.material);
    mesh.name = NAME;
    mesh.castShadow = mesh.receiveShadow = true;
    o.node.add(mesh);
    src.visible = false;
    this.states.set(o, { mesh, pieces, src: src.geometry, sig: '' });
    this.place(o);
  }

  // 破片の置き場所 (エフェクタをかけた後) で、頂点を書き直す
  private place(o: Obj) {
    const st = this.states.get(o), s = this.settingsOf(o);
    if (!st || !s) return;
    const env = this.c4d.env(o);
    // (破片の中心は物の node から見た位置なので、クローンと同じく、物から見た置き場所としてエフェクタをかける)
    const ps: Placement[] = st.pieces.map(p => ({ x: p.center.x, y: p.center.y, z: p.center.z, ry: 0, scale: 1, delay: 0 }));
    applyEffectors(ps, s.effectors, env);
    const sig = JSON.stringify(ps);
    if (sig === st.sig) return;
    st.sig = sig;
    const pos = st.mesh.geometry.getAttribute('position') as THREE.BufferAttribute, nor = st.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const P = pos.array as Float32Array, Nn = nor.array as Float32Array;
    let k = 0;
    st.pieces.forEach((piece, i) => {
      const p = ps[i], c = Math.cos(p.ry), sn = Math.sin(p.ry), sc = p.scale;
      for (let j = 0; j < piece.positions.length; j += 3, k += 3) {
        const x = piece.positions[j] * sc, y = piece.positions[j + 1] * sc, z = piece.positions[j + 2] * sc;
        P[k] = p.x + x * c + z * sn; P[k + 1] = p.y + y; P[k + 2] = p.z - x * sn + z * c;
        const nx = piece.normals[j], nz = piece.normals[j + 2];
        Nn[k] = nx * c + nz * sn; Nn[k + 1] = piece.normals[j + 1]; Nn[k + 2] = -nx * sn + nz * c;
      }
    });
    pos.needsUpdate = nor.needsUpdate = true;
    st.mesh.geometry.computeBoundingSphere();
    st.mesh.geometry.computeBoundingBox();
    this.api.engine.viewport.requestDraw();
  }

  // 描く前: 材質 (スロットを替えた)・形 (デフォーマ) を合わせ、時刻・位置で変わるエフェクタがあれば並べ直す
  private sync() {
    for (const o of this.api.engine.world.objects) {
      const st = this.states.get(o), s = this.settingsOf(o);
      if (!st || !s || !o.mesh) continue;
      if (st.src !== o.mesh.geometry || this.c4d.cloner(o)) { this.rebuild(o); continue; }
      if (st.mesh.material !== o.mesh.material) st.mesh.material = o.mesh.material;
      o.mesh.visible = false;
      if (hasLive(s.effectors, this.c4d.env(o))) this.place(o);
    }
  }
}
