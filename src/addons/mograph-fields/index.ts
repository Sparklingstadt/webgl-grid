import * as THREE from 'three';
import type { AddonModule } from '../../engine/addons/Addons';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { paramsOf, type FieldGizmo } from '../cinema4d/effectors';
import { FIELDS } from './fields';

export { FIELDS } from './fields';

// --- MoGraph フィールド: エフェクタの効く範囲 (Cinema 4D のフィールド) ---
// Cinema 4D アドオンに、フィールドの種類 (リニア・球・ボックス・円柱・放射・ランダム・ノイズ・タイム) を登録する。
// 選んでいる物のエフェクタに付いた、場所を持つフィールドは、ビューポートに枠を出す (レンダリングには写らない)
const COLOR = 0x6fb0ff, INNER = 0x35618f;

function circle(r: number, axis: 'x' | 'y' | 'z', y = 0): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = i / 48 * Math.PI * 2, c = Math.cos(a) * r, s = Math.sin(a) * r;
    pts.push(axis === 'y' ? new THREE.Vector3(c, y, s) : axis === 'x' ? new THREE.Vector3(y, c, s) : new THREE.Vector3(c, s, y));
  }
  return pts;
}
const line = (pts: THREE.Vector3[], color: number) =>
  new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false }));

// 枠 1 つ (線の集まり)
function gizmoObject(g: FieldGizmo) {
  const group = new THREE.Group();
  group.position.set(...g.center);
  const add = (o: THREE.Object3D) => { o.renderOrder = 10; group.add(o); };
  const ring = (r: number, color: number) => { for (const a of ['x', 'y', 'z'] as const) add(line(circle(r, a), color)); };
  if (g.shape === 'sphere') {
    ring(g.size[0], COLOR);
    if (g.inner) ring(g.size[0] * g.inner, INNER);
  } else if (g.shape === 'box') {
    const box = (k: number, color: number) => add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(g.size[0] * k, g.size[1] * k, g.size[2] * k)),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false })));
    box(1, COLOR);
    if (g.inner) box(g.inner, INNER);
  } else if (g.shape === 'cylinder') {
    const [r, h] = g.size;
    for (const y of [-h / 2, h / 2]) add(line(circle(r, 'y', y), COLOR));
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; add(line([new THREE.Vector3(Math.cos(a) * r, -h / 2, Math.sin(a) * r), new THREE.Vector3(Math.cos(a) * r, h / 2, Math.sin(a) * r)], COLOR)); }
    if (g.inner) add(line(circle(r * g.inner, 'y'), INNER));
  } else {
    // リニア: 軸にそった矢印と、0 と 1 の境の面
    const L = g.size[0], dir = new THREE.Vector3(g.axis === 'x' ? 1 : 0, g.axis === 'y' ? 1 : 0, g.axis === 'z' ? 1 : 0);
    add(line([dir.clone().multiplyScalar(-L / 2), dir.clone().multiplyScalar(L / 2)], COLOR));
    const across = g.axis === 'y' ? 'y' : g.axis === 'x' ? 'x' : 'z';
    for (const k of [-L / 2, L / 2]) add(line(circle(0.5, across, k), k > 0 ? COLOR : INNER));
  }
  group.traverse(o => { o.userData.editorOnly = true; o.raycast = () => {}; });
  return group;
}

const mographFields: AddonModule = {
  id: 'mograph-fields',
  name: 'MoGraph フィールド',
  version: '1.0.0',
  author: 'webgl-grid',
  category: 'MoGraph',
  description: 'Cinema 4D のフィールド: リニア・球・ボックス・円柱・放射・ランダム・ノイズ・タイム。エフェクタの「フィールド」から足して、効く範囲を決めます (重ね方・不透明度・反転)。',
  enabledByDefault: true,
  requires: ['cinema4d'],
  register(api) {
    const c4d = api.require<Cinema4d>('cinema4d');
    const { engine } = api;
    const offs = FIELDS.map(def => c4d.addField(def));
    // 選んでいる物のフィールドの枠
    const holder = new THREE.Group();
    holder.userData.editorOnly = true;
    engine.graph.scene.add(holder);
    let sig = '';
    const clear = () => { for (const c of [...holder.children]) { holder.remove(c); c.traverse(o => { (o as THREE.Line).geometry?.dispose(); ((o as THREE.Line).material as THREE.Material | undefined)?.dispose(); }); } };
    api.onBeforeRender(() => {
      const o = engine.selection.current;
      const gizmos: FieldGizmo[] = [];
      for (const e of o ? c4d.effectorsOf(o) : []) {
        if (!e.enabled) continue;
        for (const l of e.fields) {
          const def = l.enabled ? c4d.fields.get(l.kind) : undefined;
          const g = def?.gizmo?.(paramsOf(def.params, l.params));
          if (g) gizmos.push(g);
        }
      }
      const next = JSON.stringify(gizmos);
      if (next === sig) return;
      sig = next;
      clear();
      for (const g of gizmos) holder.add(gizmoObject(g));
    });
    return () => {
      for (const off of offs) off();
      clear();
      engine.graph.scene.remove(holder);
      engine.viewport.requestDraw();
    };
  },
};
export default mographFields;
