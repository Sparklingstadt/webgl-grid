import type * as THREE from 'three';
import { Emitter } from '../../core/events';
import { SHAPE_NAMES } from '../../core/constants';
import { isModel, type ModelObj, type Obj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { World } from './World';

const SELECT_COLOR = [1, 0.35, 0.02]; // #ffa028 (リニア)

// --- 選択 (Blender のように、選んだ物はオレンジの輪郭線で囲む) ---
export class Selection {
  current: Obj | null = null;
  readonly events = new Emitter<{ changed: [obj: Obj | null] }>();

  constructor(world: World, private ui: UiChannel) {
    world.events.on('removed', obj => { if (this.current === obj) this.select(null); });
  }

  // 選んでいる MMD モデル (形を選んでいるときや、何も選んでいないときは null)
  get model(): ModelObj | null { return isModel(this.current) ? this.current : null; }

  select(obj: Obj | null) {
    if (this.current === obj) return;
    this.current = obj;
    this.events.emit('changed', obj);
    this.publish();
    this.ui.bump('modelVersion');
    this.ui.bump('keysVersion');
  }

  // 選んでいる物の名前・位置などを画面に知らせる (変わったときだけ)
  publish() {
    const o = this.current;
    if (!o) { this.ui.set({ sel: null }); return; }
    const prev = this.ui.state.sel;
    const name = nameOf(o);
    if (prev && prev.id === o.id && prev.x === o.x && prev.y === o.y && prev.z === o.z && prev.r === o.r &&
        prev.c === o.c && prev.animated === !!o.animated && prev.name === name && prev.cloner === (o.cloner ?? null) && prev.deformers === (o.deformers ?? null)) return;
    this.ui.set({ sel: { id: o.id, kind: o.s === 3 ? 'model' : 'shape', name, c: o.c, x: o.x, y: o.y, z: o.z, r: o.r, animated: !!o.animated, cloner: o.cloner ?? null, deformers: o.deformers ?? null } });
  }

  // 描く前: 輪郭線 (OutlineEffect) の設定を、マテリアルの輪郭線 (outlineBase) から作る。
  // 選んでいる物だけはオレンジにする (MMD モデルは輪郭線のない材質にも付ける)。材質は物ごとに別なので、ほかの物には付かない
  // hide: 選択の輪郭線を出さない (レンダリング中)
  syncOutlines(objects: Obj[], hide = false) {
    for (const obj of objects) {
      const on = !hide && obj === this.current;
      obj.node.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.visible) return;
        for (const m of [mesh.material].flat()) {
          const base = m.userData.outlineBase ?? { visible: false };
          m.userData.outlineParameters = on
            ? { ...base, visible: true, color: SELECT_COLOR, alpha: 1,
                thickness: obj.s === 3 ? Math.max(base.thickness ?? 0, 0.004) : 0.008 }
            : base;
        }
      });
    }
  }
}

export const nameOf = (o: Obj) => (isModel(o) ? (o.model.name || 'モデル') : SHAPE_NAMES[o.s]);
