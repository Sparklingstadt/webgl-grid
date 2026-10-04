import * as THREE from 'three';
import { areaSize, lightAim, lightIntensity, normalizeLight, type LightSettings } from '../../core/light';
import type { Viewport } from '../render/Viewport';
import type { Obj } from '../types';
import type { World } from './World';

const DOWN = new THREE.Vector3(0, -1, 0), FORWARD = new THREE.Vector3(0, 0, -1);
let areaReady: Promise<void> | null = null; // エリアライトの計算に使う表 (初めて使うときに読む)
let areaLoaded = false;

// --- ライトのオブジェクト (Blender のライト): ポイント・サン・スポット・エリア ---
// 物の node の中に、three.js の光と、ビューポートの目印 (選んで運べる。レンダリングでは描かない) を作る。
// サン・スポット・エリアは、真下から傾けた向き (物の向きで回る) を照らす。サンは置いた場所によらず、場面全体を同じ向きから照らす
export class Lights {
  constructor(private world: World, private viewport: Viewport) {}

  add(settings: Partial<LightSettings>, x: number, z: number): Obj {
    const obj = this.world.addLight(new THREE.Group(), x, z, normalizeLight(settings));
    this.build(obj);
    return obj;
  }
  // 設定を変える (渡したところだけ)。強さ・色・高さだけなら、作り直さずにその場で変える (キーで毎フレーム変わるので)
  set(obj: Obj, patch: Partial<LightSettings>) {
    if (!obj.light) return;
    const prev = obj.light, next = normalizeLight({ ...prev, ...patch });
    obj.light = next;
    if (!this.update(obj, prev, next)) this.build(obj);
    this.world.settle(); // (高さ)
  }
  private update(obj: Obj, prev: LightSettings, next: LightSettings) {
    const quick = new Set<keyof LightSettings>(['power', 'strength', 'color', 'height']);
    if ((Object.keys(next) as (keyof LightSettings)[]).some(k => !quick.has(k) && next[k] !== prev[k])) return false;
    if (next.type === 'area' && !areaLoaded) return false;
    const color = new THREE.Color(next.color), power = lightIntensity(next);
    let found = false;
    obj.node.children[0].traverse(o => {
      const l = o as THREE.Light;
      if (l.isLight) {
        l.color.copy(color);
        l.intensity = power;
        const sun = l as THREE.DirectionalLight;
        if (sun.isDirectionalLight) { sun.shadow.camera.far = 30 + next.height * 3; sun.shadow.camera.updateProjectionMatrix(); }
        found = true;
      }
      const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (o.userData.lightColor && m) m.color.copy(color);
      if (o.userData.heightLine) (o as THREE.Line).geometry.setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -next.height, 0)]);
    });
    this.viewport.requestDraw();
    return found;
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
    const gizmo = (g: THREE.BufferGeometry) => Object.assign(new THREE.Mesh(g, gizmoMat), { userData: { editorOnly: true, lightColor: true } });
    const power = lightIntensity(s);
    if (s.type === 'point') {
      const l = new THREE.PointLight(color, power, s.range, 2);
      shadow(l, s.shadows, s.radius);
      holder.add(l, gizmo(new THREE.SphereGeometry(Math.max(0.12, Math.min(s.radius, 1)), 16, 8)));
    } else if (s.type === 'sun') {
      // 光は向きだけが効く。影は、ライトのまわり (横 ±12) を、照らす向きから計算する
      const l = new THREE.DirectionalLight(color, power);
      l.position.copy(aim).multiplyScalar(-30);
      shadow(l, s.shadows, s.angleDeg * 4);
      Object.assign(l.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 30 + s.height * 3 });
      l.shadow.mapSize.set(2048, 2048);
      // 目印: 小さな玉と、照らす向きへの線
      const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), aim.clone().multiplyScalar(1.2)]),
        new THREE.LineBasicMaterial({ color }));
      ray.userData.editorOnly = true;
      ray.userData.lightColor = true;
      ray.raycast = () => {};
      holder.add(l, l.target, gizmo(new THREE.SphereGeometry(0.16, 16, 8)), ray);
    } else if (s.type === 'spot') {
      // スポットサイズは円すい全体の角度、ブレンドは縁のぼけ (Blender と同じ)
      const l = new THREE.SpotLight(color, power, s.range, Math.min(s.spotSizeDeg, 179) / 2 * Math.PI / 180, s.blend, 2);
      shadow(l, s.shadows, s.radius);
      l.target.position.copy(aim);
      // 目印: 開いた口を照らす向きへ向けた円すい
      const cone = gizmo(new THREE.ConeGeometry(0.14, 0.28, 16, 1, true).translate(0, -0.14, 0).rotateX(Math.PI));
      cone.quaternion.setFromUnitVectors(DOWN, aim);
      (cone.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide;
      holder.add(l, l.target, cone);
    } else {
      const [w, h] = areaSize(s);
      const l = new THREE.RectAreaLight(color, power, w, h);
      l.quaternion.setFromUnitVectors(FORWARD, aim);
      const panel = gizmo(new THREE.PlaneGeometry(w, h));
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
    line.userData.heightLine = true;
    line.raycast = () => {};
    holder.add(line);
    this.viewport.requestDraw();
  }

  private loadArea() {
    areaReady ??= import('three/examples/jsm/lights/RectAreaLightUniformsLib.js').then(m => { m.RectAreaLightUniformsLib.init(); areaLoaded = true; });
    return areaReady;
  }
}

// 影。soft (半径・角度) が大きいほど、影の縁をぼかす
function shadow(l: THREE.PointLight | THREE.SpotLight | THREE.DirectionalLight, on: boolean, soft: number) {
  l.castShadow = on;
  l.shadow.radius = 1 + Math.min(soft, 1) * 8;
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
