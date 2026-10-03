import * as THREE from 'three';
import { lightAim, normalizeLight, type LightSettings } from '../../core/light';
import type { Viewport } from '../render/Viewport';
import type { Obj } from '../types';
import type { World } from './World';

const DOWN = new THREE.Vector3(0, -1, 0), FORWARD = new THREE.Vector3(0, 0, -1);
let areaReady: Promise<void> | null = null; // エリアライトの計算に使う表 (初めて使うときに読む)
let areaLoaded = false;

// --- ライトのオブジェクト (Cinema 4D のライト): 点光源・スポットライト・エリアライト ---
// 物の node の中に、three.js の光と、ビューポートの目印 (選んで運べる。レンダリングでは描かない) を作る。
// スポットとエリアは、真下から傾けた向き (物の向きで回る) を照らす
export class Lights {
  constructor(private world: World, private viewport: Viewport) {}

  add(settings: Partial<LightSettings>, x: number, z: number): Obj {
    const obj = this.world.addLight(new THREE.Group(), x, z, normalizeLight(settings));
    this.build(obj);
    return obj;
  }
  // 設定を変える (渡したところだけ)
  set(obj: Obj, patch: Partial<LightSettings>) {
    if (!obj.light) return;
    obj.light = normalizeLight({ ...obj.light, ...patch });
    this.build(obj);
    this.world.settle(); // (高さ)
  }

  // 光と目印を作り直す
  private build(obj: Obj) {
    const s = obj.light!;
    const holder = obj.node.children[0];
    if (s.type === 'area' && !areaLoaded) { void this.loadArea().then(() => this.build(obj)); return; }
    for (const c of [...holder.children]) { holder.remove(c); disposeTree(c); }
    const color = new THREE.Color(s.color);
    const aim = new THREE.Vector3(...lightAim(s.tiltDeg));
    const gizmoMat = new THREE.MeshBasicMaterial({ color, userData: { outlineBase: { visible: false } } });
    const gizmo = (g: THREE.BufferGeometry) => Object.assign(new THREE.Mesh(g, gizmoMat), { userData: { editorOnly: true } });
    if (s.type === 'point') {
      const l = new THREE.PointLight(color, s.intensity, s.range, 2);
      shadow(l, s.shadows);
      holder.add(l, gizmo(new THREE.SphereGeometry(0.12, 16, 8)));
    } else if (s.type === 'spot') {
      const l = new THREE.SpotLight(color, s.intensity, s.range, s.angleDeg * Math.PI / 180, s.softness, 2);
      shadow(l, s.shadows);
      l.target.position.copy(aim);
      // 目印: 開いた口を照らす向きへ向けた円すい
      const cone = gizmo(new THREE.ConeGeometry(0.14, 0.28, 16, 1, true).translate(0, -0.14, 0).rotateX(Math.PI));
      cone.quaternion.setFromUnitVectors(DOWN, aim);
      (cone.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide;
      holder.add(l, l.target, cone);
    } else {
      const l = new THREE.RectAreaLight(color, s.intensity, s.width, s.depth);
      l.quaternion.setFromUnitVectors(FORWARD, aim);
      const panel = gizmo(new THREE.PlaneGeometry(s.width, s.depth));
      panel.quaternion.copy(l.quaternion);
      (panel.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide;
      (panel.material as THREE.MeshBasicMaterial).transparent = true;
      (panel.material as THREE.MeshBasicMaterial).opacity = 0.6;
      holder.add(l, panel);
    }
    // 目印: 床までの細い線 (高さが分かるように。当たり判定はしない)
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -s.height, 0)]),
      new THREE.LineBasicMaterial({ color: 0x8a8a8a, transparent: true, opacity: 0.6 }));
    line.userData.editorOnly = true;
    line.raycast = () => {};
    holder.add(line);
    this.viewport.requestDraw();
  }

  private loadArea() {
    areaReady ??= import('three/examples/jsm/lights/RectAreaLightUniformsLib.js').then(m => { m.RectAreaLightUniformsLib.init(); areaLoaded = true; });
    return areaReady;
  }
}

function shadow(l: THREE.PointLight | THREE.SpotLight, on: boolean) {
  l.castShadow = on;
  l.shadow.mapSize.set(1024, 1024);
  l.shadow.bias = -0.0005;
  l.shadow.normalBias = 0.02;
}
function disposeTree(o: THREE.Object3D) {
  o.traverse(c => {
    const m = c as THREE.Mesh;
    m.geometry?.dispose();
    for (const mat of [m.material].flat()) (mat as THREE.Material | undefined)?.dispose?.();
    (c as THREE.Light).dispose?.();
  });
}
