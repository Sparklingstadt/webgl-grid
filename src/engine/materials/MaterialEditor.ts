import * as THREE from 'three';
import { t } from '../../core/i18n';
import type { NodeType, SocketValue } from '../../core/materials/nodes';
import { addNode, connect, disconnect, findNode, removeNode, surfaceShader, whyNotConnect, type SocketRef } from '../../core/materials/tree';
import type { UiChannel } from '../UiChannel';
import type { Selection } from '../world/Selection';
import type { World } from '../world/World';
import type { MaterialData, MaterialLibrary, MaterialOutline, MaterialSettings } from './MaterialLibrary';

// --- 選んでいる物のマテリアルの編集 (Blender の「マテリアル」プロパティとシェーダーエディター) ---
// 物のマテリアルスロット・スロットに入れるマテリアル・そのノードツリーを、選んでいる物とスロットに対して変える
export class MaterialEditor {
  constructor(private library: MaterialLibrary, private world: World, private selection: Selection, private ui: UiChannel) {}

  slots(): { index: number; id: string | null; name: string }[] {
    const o = this.selection.current;
    return o ? o.slots.map((id, index) => ({ index, id, name: (id && this.library.materials.get(id)?.name) || '' })) : [];
  }
  activeSlot() {
    const o = this.selection.current;
    return o ? Math.min(o.activeSlot ?? 0, Math.max(o.slots.length - 1, 0)) : 0;
  }
  setActiveSlot(i: number) {
    const o = this.selection.current;
    if (!o) return;
    o.activeSlot = i;
    this.ui.bump('materialsVersion');
  }
  // 選んでいるスロットのマテリアル
  active(): MaterialData | null {
    const id = this.selection.current?.slots[this.activeSlot()];
    return (id && this.library.materials.get(id)) || null;
  }
  list() { return this.library.list(); }

  // 選んでいるスロットに、マテリアル id を入れる (null で外す)
  assign(id: string | null) {
    const o = this.selection.current;
    if (!o) return;
    this.world.setSlot(o, this.activeSlot(), id);
    this.ui.bump('materialsVersion');
  }
  create() { this.assign(this.library.create().id); }
  // 選んでいるスロットのマテリアルを複製して、そのスロットに入れる (Blender の「新規マテリアル」ボタン)
  duplicate() {
    const cur = this.active();
    if (!cur) { this.create(); return; }
    const copy = this.library.duplicate(cur.id);
    if (copy) this.assign(copy.id);
  }
  rename(name: string) { const cur = this.active(); if (cur) this.library.rename(cur.id, name); }
  private edit(fn: (data: MaterialData) => void) { const cur = this.active(); if (cur) this.library.edit(cur.id, fn); }
  setSettings(patch: Partial<MaterialSettings>) { this.edit(d => Object.assign(d.settings, patch)); }
  setOutline(patch: Partial<MaterialOutline>) { this.edit(d => Object.assign(d.outline, patch)); }

  // --- ノード ---
  setNodeValue(node: string, socket: string, value: SocketValue) {
    this.edit(d => { const n = findNode(d.tree, node); if (n) n.values[socket] = value; });
  }
  setNodeProp(node: string, prop: string, value: string) {
    this.edit(d => { const n = findNode(d.tree, node); if (n) n.props[prop] = value; });
  }
  addNode(type: NodeType, x: number, y: number) {
    let id: string | null = null;
    this.edit(d => { id = addNode(d.tree, type, x, y).id; });
    return id;
  }
  removeNode(node: string) { this.edit(d => { removeNode(d.tree, node); }); }
  moveNode(node: string, x: number, y: number) {
    this.edit(d => { const n = findNode(d.tree, node); if (n) Object.assign(n, { x, y }); });
  }
  // つなぐ。つなげなければ、その理由を返す
  connect(from: SocketRef, to: SocketRef): string | null {
    const cur = this.active();
    if (!cur) return t('マテリアルがありません');
    const why = whyNotConnect(cur.tree, from, to);
    if (why) return why;
    this.edit(d => { connect(d.tree, from, to); });
    return null;
  }
  disconnect(to: SocketRef) { this.edit(d => { disconnect(d.tree, to); }); }
  // マテリアル出力につながっているプリンシプル BSDF (サーフェス)
  surfaceShader() { const cur = this.active(); return cur ? surfaceShader(cur.tree) : null; }

  // --- 画像 ---
  images() { return [...this.library.images.values()].map(i => ({ id: i.id, name: i.name })); }
  // 画像ファイルを読み込んで、画像として登録する (MMD のモデルに使うときは、MMD と同じく上下を反転しない)
  async openImage(file: File, flipY = !this.selection.model): Promise<string> {
    const url = URL.createObjectURL(file);
    try {
      const texture = await new THREE.TextureLoader().loadAsync(url);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = flipY;
      texture.name = file.name;
      return this.library.addImage(file.name, texture, file).id;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
