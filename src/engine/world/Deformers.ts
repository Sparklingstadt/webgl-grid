import * as THREE from 'three';
import { activeDeformers, deformArrays, type Deformer } from '../../core/deform';
import type { Viewport } from '../render/Viewport';
import { isModel, type Obj } from '../types';
import type { Cloners } from './Cloners';

// --- デフォーマ (Cinema 4D のデフォーマ) ---
// 物の形 (頂点の位置と法線) を変形した写しを作って差し替える (core/deform.ts)。元の形は userData.baseGeometry に取っておく。
// MMD モデルは、ボーンで動かす前の形にかける。影・輪郭線・当たり判定・クローナーも、変形した形で動く
export class Deformers {
  constructor(private cloners: Cloners, private viewport: Viewport) {}

  set(obj: Obj, list: Deformer[]) {
    obj.deformers = list.length ? list : null;
    this.apply(obj);
  }

  apply(obj: Obj) {
    const mesh: THREE.Mesh = isModel(obj) ? obj.model : obj.mesh!;
    const base: THREE.BufferGeometry = mesh.userData.baseGeometry ?? mesh.geometry;
    const prev = mesh.geometry;
    const active = activeDeformers(obj.deformers);
    if (!active.length) {
      mesh.geometry = base;
      delete mesh.userData.baseGeometry;
    } else {
      mesh.userData.baseGeometry = base;
      mesh.geometry = deformGeometry(base, active);
    }
    if (prev !== base && prev !== mesh.geometry) prev.dispose(); // 前に変形した写しは捨てる (元の形は残す)
    const proxy = obj.node.children.find(c => c.userData.pickProxy) as THREE.Mesh | undefined;
    if (proxy) proxy.geometry = mesh.geometry; // MMD モデルの当たり判定も、変形した形で
    if (obj.cloner) this.cloners.rebuild(obj);
    this.viewport.requestDraw();
  }
}

// 元の形と、位置と法線だけを変形した写し (ほかの頂点の情報 (UV・骨の重み・モーフ) と userData は共有する)
function deformGeometry(base: THREE.BufferGeometry, list: Deformer[]) {
  if (!base.boundingBox) base.computeBoundingBox();
  const b = base.boundingBox!;
  const pos = base.getAttribute('position') as THREE.BufferAttribute, nor = base.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const { positions, normals } = deformArrays(pos.array, nor?.array ?? null, list, { min: b.min.toArray(), max: b.max.toArray() });
  const g = new THREE.BufferGeometry();
  g.setIndex(base.getIndex());
  for (const [name, attr] of Object.entries(base.attributes)) g.setAttribute(name, attr);
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (normals) g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.morphAttributes = base.morphAttributes;
  g.morphTargetsRelative = base.morphTargetsRelative;
  for (const gr of base.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  g.userData = base.userData; // (MMD の剛体などの情報)
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
