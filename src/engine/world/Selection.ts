import type * as THREE from 'three';
import { Emitter } from '../../core/events';
import { t } from '../../core/i18n';
import { lightName } from '../../core/light';
import { shapeName } from '../../core/shapes';
import { isModel, kindOf, type ModelObj, type Obj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { World } from './World';

const ACTIVE_COLOR = [1, 0.35, 0.02]; // #ffa028 (リニア): アクティブ
const SELECT_COLOR = [0.88, 0.1, 0]; // #f15800 (リニア): ほかの選んでいる物

// --- 選択 (Blender と同じ): 選んでいる物の集まりと、その中のアクティブ (最後に選んだ物。サイドバー・プロパティで変えるのはこれ) ---
// 選んだ物はオレンジの輪郭線で囲む (アクティブは明るく、ほかは濃く)
export class Selection {
  current: Obj | null = null; // アクティブ
  readonly selected = new Set<Obj>();
  readonly events = new Emitter<{ changed: [obj: Obj | null] }>(); // アクティブが変わった

  constructor(private world: World, private ui: UiChannel) {
    world.events.on('removed', obj => this.deselect(obj));
  }

  // 選んでいる MMD モデル (形を選んでいるときや、何も選んでいないときは null)
  get model(): ModelObj | null { return isModel(this.current) ? this.current : null; }
  // 選んでいる物 (置いた順)
  get list() { return this.world.objects.filter(o => this.selected.has(o)); }
  isSelected(obj: Obj) { return this.selected.has(obj); }

  // それだけを選ぶ (null で選択を解除)
  select(obj: Obj | null) { this.setMany(obj ? [obj] : [], obj); }
  // Shift+クリック: 選んでいなければ足してアクティブに、選んでいればアクティブに、アクティブなら外す
  toggle(obj: Obj) {
    if (this.selected.has(obj) && this.current === obj) { this.selected.delete(obj); this.setActive(null); }
    else { this.selected.add(obj); this.setActive(obj); }
    this.publishSet();
  }
  // まとめて選ぶ (extend: いまの選択に足す)。アクティブは、指定がなければ最後の物
  setMany(objs: Obj[], active: Obj | null = objs.at(-1) ?? null, extend = false) {
    if (!extend) this.selected.clear();
    for (const o of objs) this.selected.add(o);
    if (active) this.selected.add(active);
    this.setActive(active ?? (extend ? this.current : null));
    this.publishSet();
  }
  // 選択から外す (消した・隠した物)
  deselect(obj: Obj) {
    if (!this.selected.delete(obj) && this.current !== obj) return;
    if (this.current === obj) this.setActive(null);
    this.publishSet();
  }
  // アクティブだけを変える (選んでいる物の中の 1 つに)
  setActive(obj: Obj | null) {
    if (obj) this.selected.add(obj);
    if (this.current === obj) return;
    this.current = obj;
    this.events.emit('changed', obj);
    this.publish();
    this.ui.bump('modelVersion');
    this.ui.bump('keysVersion');
  }
  private publishSet() {
    const ids = this.list.map(o => o.id);
    const prev = this.ui.state.selIds;
    if (prev.length !== ids.length || prev.some((id, i) => id !== ids[i])) this.ui.set({ selIds: ids });
  }

  // 選んでいる物の名前・位置などを画面に知らせる (変わったときだけ)
  publish() {
    const o = this.current;
    if (!o) { this.ui.set({ sel: null }); return; }
    const prev = this.ui.state.sel;
    const name = nameOf(o);
    if (prev && prev.id === o.id && prev.x === o.x && prev.y === o.y && prev.z === o.z && prev.r === o.r &&
        prev.c === o.c && prev.scale === (o.scale ?? 1) && prev.animated === !!o.animated && prev.name === name && prev.light === (o.light ?? null) && prev.camera === (o.camera ?? null)) return;
    this.ui.set({ sel: { id: o.id, kind: kindOf(o), name, c: o.c, x: o.x, y: o.y, z: o.z, r: o.r, scale: o.scale ?? 1, animated: !!o.animated, light: o.light ?? null, camera: o.camera ?? null } });
  }

  // 描く前: 輪郭線 (OutlineEffect) の設定を、マテリアルの輪郭線 (outlineBase) から作る。
  // 選んでいる物だけはオレンジにする (MMD モデルは輪郭線のない材質にも付ける)。材質は物ごとに別なので、ほかの物には付かない
  // hide: 選択の輪郭線を出さない (レンダリング中)
  syncOutlines(objects: Obj[], hide = false) {
    for (const obj of objects) {
      const on = !hide && this.selected.has(obj), active = obj === this.current;
      obj.node.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.visible) return;
        for (const m of [mesh.material].flat()) {
          const base = m.userData.outlineBase ?? { visible: false };
          m.userData.outlineParameters = on
            ? { ...base, visible: true, color: active ? ACTIVE_COLOR : SELECT_COLOR, alpha: 1,
                thickness: isModel(obj) ? Math.max(base.thickness ?? 0, 0.004) : 0.008 }
            : base;
        }
      });
    }
  }
}

// 物の名前: 付けた名前か、種類の名前 (モデルは .pmx の中の名前)
export const kindName = (o: Obj) => (isModel(o) ? (o.model.name || t('モデル')) : o.light ? lightName(o.light.type) : o.camera ? t('カメラ') : shapeName(o.s));
export const nameOf = (o: Obj) => o.name || kindName(o);
