import * as THREE from 'three';
import type { UiChannel } from '../UiChannel';
import type { Obj } from '../types';
import type { Selection } from '../world/Selection';
import type { World } from '../world/World';
import { SHADING_MODES, type ShadingMode, type Viewport } from './Viewport';

const KEY = 'webgl-grid-shading';
const HIDDEN = { visible: false };
const WIRE = 0x9a9a9a, WIRE_SELECT = 0xf15800, WIRE_ACTIVE = 0xffa028;

// --- ビューポートの表示 (Z): ワイヤーフレーム・ソリッド・マテリアル・レンダー ---
// ワイヤーフレームとソリッドは、描くあいだだけ物 (とステージ) の材質を差し替える (目印など、ビューポートだけの物はそのまま)。
// ソリッドはマットキャップ (光の当たり方を絵にした灰色) で、場面のライトによらず形が分かる。輪郭線は選んでいる物だけ (MMD の輪郭線は出さない)。
// ワイヤーフレームは辺だけを描き、選んでいる物はオレンジ。設定はブラウザに保存する
export class Shading {
  private solid = new WeakMap<THREE.Material, THREE.MeshMatcapMaterial>();
  private wire = new WeakMap<THREE.Material, THREE.MeshBasicMaterial>();
  private swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
  private matcap: THREE.Texture | null = null;

  constructor(private viewport: Viewport, private ui: UiChannel, private world: World, private selection: Selection, private stage: () => THREE.Object3D | null) {
    let saved: string | null = null;
    try { saved = localStorage.getItem(KEY); } catch { /* 使えなくても動く */ }
    this.set(SHADING_MODES.includes(saved as ShadingMode) ? saved as ShadingMode : 'rendered', false);
    viewport.swapMaterials = { begin: mode => this.begin(mode), end: () => this.end() };
  }

  get mode() { return this.viewport.shading; }
  set(mode: ShadingMode, save = true) {
    this.viewport.shading = mode;
    this.ui.set({ shading: mode });
    if (save) try { localStorage.setItem(KEY, mode); } catch { /* 保存できなくても使える */ }
    this.viewport.requestDraw();
  }
  // Shift+Z: ワイヤーフレームと、その前の表示を行き来する
  private before: ShadingMode = 'rendered';
  toggleWireframe() {
    if (this.mode === 'wireframe') this.set(this.before);
    else { this.before = this.mode; this.set('wireframe'); }
  }

  private begin(mode: 'wireframe' | 'solid') {
    const objs: [THREE.Object3D, Obj | null][] = this.world.objects.map(o => [o.node, o]);
    const stage = this.stage();
    if (stage) objs.push([stage, null]);
    for (const [root, obj] of objs) {
      const picked = !!obj && this.selection.isSelected(obj);
      const color = picked ? (obj === this.selection.current ? WIRE_ACTIVE : WIRE_SELECT) : WIRE;
      const visit = (o: THREE.Object3D) => {
        if (o.userData.editorOnly) return;
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.material) {
          this.swapped.push([mesh, mesh.material]);
          mesh.material = Array.isArray(mesh.material)
            ? mesh.material.map(m => this.stand(m, mode, color, picked))
            : this.stand(mesh.material, mode, color, picked);
        }
        for (const c of o.children) visit(c);
      };
      visit(root);
    }
  }
  private end() {
    for (const [mesh, m] of this.swapped) mesh.material = m;
    this.swapped = [];
  }
  // 元の材質の代わり (元ごとに 1 つ。両面・見える・輪郭線は元に合わせる)
  private stand(m: THREE.Material, mode: 'wireframe' | 'solid', color: number, picked: boolean): THREE.Material {
    if (mode === 'wireframe') {
      let w = this.wire.get(m);
      if (!w) this.wire.set(m, w = new THREE.MeshBasicMaterial({ wireframe: true, userData: { outlineParameters: HIDDEN } }));
      w.color.setHex(color);
      w.visible = m.visible;
      return w;
    }
    let s = this.solid.get(m);
    if (!s) this.solid.set(m, s = new THREE.MeshMatcapMaterial({ matcap: this.matcapTexture() }));
    s.side = m.side;
    s.visible = m.visible && !(m instanceof THREE.ShadowMaterial);
    s.userData.outlineParameters = picked ? m.userData.outlineParameters : HIDDEN;
    return s;
  }
  // マットキャップ: 左上から光が当たった灰色の球 (Blender のスタジオライトに近い)
  private matcapTexture() {
    if (this.matcap) return this.matcap;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(46, 40, 4, 64, 64, 64);
    grad.addColorStop(0, '#f2f2f2');
    grad.addColorStop(0.45, '#b4b4b4');
    grad.addColorStop(0.85, '#6a6a6a');
    grad.addColorStop(1, '#4a4a4a');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    this.matcap = new THREE.CanvasTexture(c);
    this.matcap.colorSpace = THREE.SRGBColorSpace;
    return this.matcap;
  }
}
