import * as THREE from 'three';
import { MMD_SCALE } from '../constants';
import { requestDraw } from '../loop';
import { disposeModel } from '../objects';
import { grid, scene, shadowPlane } from '../scene';
import type { Any } from '../types';

// --- MMD のステージ ---
// 横幅か奥行きが 40 (MMD の単位) を超えるか、名前に「ステージ」などを含む .pmx はステージとして扱う。
// ステージは原点に 1 つだけ置き、掴んだり積んだりはできない (触るとカメラの操作になる)
export const STAGE = Symbol('stage');
export let stageModel: Any = null;

export function isStageModel(mesh: THREE.Object3D, fileName: string) {
  const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
  return Math.max(size.x, size.z) > 40 || /ステージ|stage|舞台/i.test(`${mesh.name} ${fileName}`);
}
export function addStage(mesh: Any) {
  removeStage();
  mesh.scale.setScalar(MMD_SCALE);
  mesh.traverse((o: Any) => {
    if (!o.isMesh) return;
    o.raycast = () => {};    // 掴めない
    o.castShadow = false;     // 屋根や壁で全体が影にならないよう、影は受けるだけ
    o.receiveShadow = true;
  });
  scene.add(mesh);
  stageModel = mesh;
  // ステージの床とちらつかないよう、地面のグリッドと影の板は隠す (影はステージの床が受ける)
  grid.visible = shadowPlane.visible = false;
  requestDraw();
}
export function removeStage() {
  if (!stageModel) return;
  scene.remove(stageModel);
  disposeModel(stageModel);
  stageModel = null;
  grid.visible = shadowPlane.visible = true;
  requestDraw();
}
