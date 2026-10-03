import * as THREE from 'three';
import { cameraForward, normalizeCamera, type CameraSettings } from '../../core/camera';
import { DEG } from '../../core/constants';
import type { CameraOverride } from '../view/CameraController';
import type { Viewport } from '../render/Viewport';
import type { Obj } from '../types';
import type { World } from './World';

const ASPECT = 16 / 9, SIZE = 0.9;
const LINE = 0x101010, ACTIVE = 0xffa028, SELECTED = 0xf15800; // 枠の色 (選んでいると、Blender と同じくオレンジ)

// --- カメラのオブジェクト (Blender のカメラ) ---
// 物の node の中に、ビューポートの目印 (選んで運べる胴と、写す範囲の四角すいの枠。レンダリングでは描かない) を作る。
// view(obj) は、そのカメラから見る視点 (テンキー 0・レンダリング)
export class Cameras {
  constructor(private world: World, private viewport: Viewport) {}

  add(settings: Partial<CameraSettings>, x: number, z: number, r = 0): Obj {
    const obj = this.world.addCamera(new THREE.Group(), x, z, normalizeCamera(settings));
    obj.r = r;
    this.build(obj);
    return obj;
  }
  set(obj: Obj, patch: Partial<CameraSettings>) {
    if (!obj.camera) return;
    obj.camera = normalizeCamera({ ...obj.camera, ...patch });
    this.build(obj);
    this.world.settle(); // (高さ)
  }
  // 場面のカメラ (レンダリングに使う): いちばん上のカメラ
  get scene(): Obj | null { return this.world.objects.find(o => o.camera) ?? null; }

  // そのカメラから見る視点。released はユーザーが自分で視点を動かしたとき
  view(obj: Obj, released: () => void): CameraOverride {
    const target = new THREE.Vector3();
    return {
      target,
      apply: camera => {
        const s = obj.camera ?? normalizeCamera(undefined);
        const [fx, fy, fz] = cameraForward(obj.r, s.tiltDeg);
        camera.up.set(0, 1, 0);
        camera.position.set(obj.x, obj.py, obj.z);
        target.set(obj.x + fx * 10, obj.py + fy * 10, obj.z + fz * 10);
        camera.lookAt(target);
        if (camera.fov !== s.fov) { camera.fov = s.fov; camera.updateProjectionMatrix(); }
        camera.updateMatrixWorld();
      },
      released,
    };
  }

  // 描く前: 選んでいるカメラの枠をオレンジに (active: アクティブ)
  sync(isSelected: (o: Obj) => boolean, active: Obj | null) {
    for (const o of this.world.objects) {
      if (!o.camera) continue;
      const frame = o.node.getObjectByName('__camera-frame') as THREE.LineSegments | undefined;
      (frame?.material as THREE.LineBasicMaterial | undefined)?.color.setHex(o === active ? ACTIVE : isSelected(o) ? SELECTED : LINE);
    }
  }

  // 目印を作り直す: 胴 (箱) と、写す範囲の四角すい・上を示す三角
  private build(obj: Obj) {
    const s = obj.camera!;
    const holder = obj.node.children[0];
    for (const c of [...holder.children]) { holder.remove(c); c.traverse(o => { (o as THREE.Mesh).geometry?.dispose(); ((o as THREE.Mesh).material as THREE.Material | undefined)?.dispose?.(); }); }
    const aim = new THREE.Group();
    aim.rotation.x = -s.tiltDeg * DEG; // (下を向く)
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.4).translate(0, 0, 0.2),
      new THREE.MeshBasicMaterial({ color: 0x3b3b3b, userData: { outlineBase: { visible: false } } }));
    body.userData.editorOnly = true;
    const h = Math.tan(s.fov * DEG / 2) * SIZE, w = h * ASPECT;
    const c = [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => new THREE.Vector3(x, y, -SIZE));
    const o = new THREE.Vector3();
    const pts = [o, c[0], o, c[1], o, c[2], o, c[3], c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0],
      new THREE.Vector3(-w * 0.5, h * 1.1, -SIZE), new THREE.Vector3(w * 0.5, h * 1.1, -SIZE), new THREE.Vector3(w * 0.5, h * 1.1, -SIZE),
      new THREE.Vector3(0, h * 1.6, -SIZE), new THREE.Vector3(0, h * 1.6, -SIZE), new THREE.Vector3(-w * 0.5, h * 1.1, -SIZE)];
    const frame = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: LINE }));
    frame.name = '__camera-frame';
    frame.userData.editorOnly = true;
    frame.raycast = () => {};
    aim.add(body, frame);
    // 床までの細い線 (高さが分かるように)
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -s.height, 0)]),
      new THREE.LineBasicMaterial({ color: 0x8a8a8a, transparent: true, opacity: 0.6 }));
    line.userData.editorOnly = true;
    line.raycast = () => {};
    holder.add(aim, line);
    this.viewport.requestDraw();
  }
}
