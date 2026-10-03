import * as THREE from 'three';
import { MMD_SCALE } from '../../core/constants';
import type { MaterialLibrary } from '../materials/MaterialLibrary';
import type { SceneGraph } from '../render/SceneGraph';
import type { Viewport } from '../render/Viewport';
import type { Any } from '../types';
import { disposeModel } from '../world/World';

// --- MMD のステージ ---
// 横幅か奥行きが 40 (MMD の単位) を超えるか、名前に「ステージ」などを含む .pmx はステージとして扱う。
// ステージは原点に 1 つだけ置き、掴んだり積んだりはできない (触るとカメラの操作になる)
export class Stage {
  model: Any = null;

  constructor(private graph: SceneGraph, private viewport: Viewport, private lib: MaterialLibrary) {}

  static isStage(mesh: THREE.Object3D, fileName: string) {
    const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
    return Math.max(size.x, size.z) > 40 || /ステージ|stage|舞台/i.test(`${mesh.name} ${fileName}`);
  }

  set(mesh: Any) {
    this.clear();
    mesh.scale.setScalar(MMD_SCALE);
    mesh.traverse((o: Any) => {
      if (!o.isMesh) return;
      o.raycast = () => {};    // 掴めない
      o.castShadow = false;     // 屋根や壁で全体が影にならないよう、影は受けるだけ
      o.receiveShadow = true;
    });
    this.graph.scene.add(mesh);
    this.model = mesh;
    this.graph.setGroundVisible(false); // 影はステージの床が受ける
    this.viewport.requestDraw();
  }
  clear() {
    if (!this.model) return;
    this.graph.scene.remove(this.model);
    this.lib.releaseAll(this.model);
    disposeModel(this.model);
    this.model = null;
    this.graph.setGroundVisible(true);
    this.viewport.requestDraw();
  }
}
