import * as THREE from 'three';
import { msg } from '../../core/i18n';
import { int, num } from '../../core/normalize';
import type { AddonApi, ObjectData } from '../../engine/addons/Addons';
import { isShape, type Obj } from '../../engine/types';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { normalizeEffectors, type Effector, type Placement } from '../cinema4d/cloner';
import { applyEffectors, hasLive } from '../cinema4d/effectors';
import { trianglesOf } from '../mograph-fracture/voronoi';
import { extrude, facesOf, vertexCount, type Face } from './geometry';

// --- MoExtrude (Cinema 4D の MoExtrude): 形の面を、エフェクタに合わせて押し出す ---
// 面 (同じ向きでつながった三角形) ごとに、法線の向きへ「長さ」だけ押し出す。エフェクタの大きさで長さが変わり、位置でふたがずれる。
// 段の数だけ壁を分け、ふたの大きさで先を細く (太く) できる。元の形は隠す (やめると出す)。デフォーマで変えた形も押し出す
export interface ExtrudeSettings {
  offset: number;    // 押し出す長さ (m)
  steps: number;     // 段の数
  capScale: number;  // ふたの大きさ (1 でそのまま)
  effectors: Effector[];
}
export const EXTRUDE_DEFAULT: ExtrudeSettings = { offset: 0.3, steps: 1, capScale: 1, effectors: [] };
export const MAX_FACES = 400;
export function normalizeExtrude(o: Partial<ExtrudeSettings> | null | undefined): ExtrudeSettings {
  const d = EXTRUDE_DEFAULT, s = o ?? {};
  return { offset: num(s.offset, d.offset, -10, 10), steps: int(s.steps, d.steps, 1, 20), capScale: num(s.capScale, d.capScale, 0, 5), effectors: normalizeEffectors(s.effectors) };
}

interface State { mesh: THREE.Mesh; verts: THREE.Vector3[]; faces: Face[]; src: THREE.BufferGeometry; sig: string }
const NAME = '__moextrude';

export class Extrude {
  private states = new WeakMap<Obj, State>();
  private readonly data: ObjectData<ExtrudeSettings>;
  private readonly settingsOf: (o: Obj) => ExtrudeSettings | null;
  private readonly offs: (() => void)[];
  private on = true;
  readonly problems = new WeakMap<Obj, string>();

  constructor(private api: AddonApi, private c4d: Cinema4d) {
    const value = (o: Obj) => (this.on ? (o.addonData?.[`${api.id}.extrude`] as ExtrudeSettings | undefined) ?? null : null);
    this.settingsOf = value;
    this.data = api.addObjectData<ExtrudeSettings>({ key: 'extrude', label: 'MoExtrude', normalize: raw => normalizeExtrude(raw as Partial<ExtrudeSettings>), apply: o => this.rebuild(o) });
    api.onBeforeRender(() => this.sync());
    this.offs = [
      c4d.events.on('registry', () => { for (const o of api.engine.world.objects) if (this.states.has(o)) this.place(o); }),
      c4d.addEffectorSource(o => value(o)?.effectors ?? null),
    ];
  }
  off() { this.on = false; for (const f of this.offs) f(); }

  get(o: Obj | null | undefined) { return o ? this.data.get(o) : null; }
  set(o: Obj, patch: Partial<ExtrudeSettings> | null) { this.data.set(o, patch === null ? null : normalizeExtrude({ ...this.data.get(o), ...patch })); }
  faceCount(o: Obj | null | undefined) { return o ? this.states.get(o)?.faces.length ?? 0 : 0; }

  rebuild(o: Obj) {
    const old = this.states.get(o);
    if (old) { o.node.remove(old.mesh); old.mesh.geometry.dispose(); this.states.delete(o); }
    this.problems.delete(o);
    const s = this.settingsOf(o), src = o.mesh;
    if (!s || !src || !isShape(o)) { if (src && !this.c4d.cloner(o)) src.visible = true; this.api.engine.viewport.requestDraw(); return; }
    if (this.c4d.cloner(o)) { this.problems.set(o, msg('クローナーにしている物は、MoExtrude にできません')); return; }
    src.updateMatrix();
    const { verts, faces } = facesOf(trianglesOf(src.geometry, src.matrix));
    if (faces.length > MAX_FACES) { this.problems.set(o, msg('面が多すぎるので、MoExtrude にできません (400 面まで)')); src.visible = true; return; }
    const n = vertexCount(faces, s.steps);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const mesh = new THREE.Mesh(g, src.material);
    mesh.name = NAME;
    mesh.castShadow = mesh.receiveShadow = true;
    o.node.add(mesh);
    src.visible = false;
    this.states.set(o, { mesh, verts, faces, src: src.geometry, sig: '' });
    this.place(o);
  }

  // 面ごとの長さとずれ (エフェクタをかけた後) で、頂点を書き直す
  private place(o: Obj) {
    const st = this.states.get(o), s = this.settingsOf(o);
    if (!st || !s) return;
    const ps: Placement[] = st.faces.map(f => ({ x: f.center.x, y: f.center.y, z: f.center.z, ry: 0, scale: 1, delay: 0 }));
    applyEffectors(ps, s.effectors, this.c4d.env(o));
    const sig = JSON.stringify(ps) + `|${s.offset}|${s.steps}|${s.capScale}`;
    if (sig === st.sig) return;
    st.sig = sig;
    const pos = st.mesh.geometry.getAttribute('position') as THREE.BufferAttribute, nor = st.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
    extrude(st.verts, st.faces, ps.map(p => s.offset * p.scale), ps.map((p, i) => new THREE.Vector3(p.x, p.y, p.z).sub(st.faces[i].center)), s.capScale, s.steps,
      { positions: pos.array as Float32Array, normals: nor.array as Float32Array });
    pos.needsUpdate = nor.needsUpdate = true;
    st.mesh.geometry.computeBoundingSphere();
    st.mesh.geometry.computeBoundingBox();
    this.api.engine.viewport.requestDraw();
  }

  // 描く前: 材質・形 (デフォーマ) を合わせ、時刻・位置で変わるエフェクタがあれば押し出し直す
  private sync() {
    for (const o of this.api.engine.world.objects) {
      const st = this.states.get(o), s = this.settingsOf(o);
      if (!st || !s || !o.mesh) continue;
      if (st.src !== o.mesh.geometry || this.c4d.cloner(o) || vertexCount(st.faces, s.steps) * 3 !== (st.mesh.geometry.getAttribute('position').array as Float32Array).length) { this.rebuild(o); continue; }
      if (st.mesh.material !== o.mesh.material) st.mesh.material = o.mesh.material;
      o.mesh.visible = false;
      if (hasLive(s.effectors, this.c4d.env(o))) this.place(o);
    }
  }
}
