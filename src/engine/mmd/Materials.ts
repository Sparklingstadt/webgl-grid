import * as THREE from 'three';
import type { Viewport } from '../render/Viewport';
import type { Any, ModelObj } from '../types';
import type { UiChannel } from '../UiChannel';

// 材質の、画面で変えられる値。色は '#rrggbb' (画面に見える色)
export interface MaterialProps {
  name: string;
  visible: boolean;
  diffuse: string;     // 色 (拡散色)
  opacity: number;     // 不透明度
  ambient: string;     // 環境色 (three.js の MMD の材質では emissive に入っている)
  specular: string;    // 反射色
  shininess: number;   // 反射の強さ
  edgeVisible: boolean;
  edgeColor: string;
  edgeSize: number;    // 輪郭線の太さ (MMD の「エッジサイズ」と同じ目盛り)
}
export interface MaterialItem { index: number; name: string; visible: boolean; edited: boolean }

// MMD のエッジサイズ 1 が、OutlineEffect の太さ 1/300 にあたる (MMDLoader と同じ換算)
const EDGE_SCALE = 300;
const _c = new THREE.Color();
const hexOf = (c: THREE.Color) => `#${c.getHexString()}`;
// 輪郭線の色は OutlineEffect が配列 (作業用のリニアな色) で持っている
const edgeHex = (arr: number[]) => hexOf(_c.fromArray(arr));
const edgeArray = (hex: string) => _c.set(hex).toArray();

// 輪郭線の元の設定。選んでいるあいだはオレンジの輪郭線に差し替えているので (world/Selection.ts)、
// その元の設定 (baseOutline) があればそちらを読み書きする
const outlineOf = (m: Any) => (m.userData.baseOutline ?? m.userData.outlineParameters ?? { visible: false, thickness: 0, color: [0, 0, 0], alpha: 1 });

// --- MMD モデルの材質 (Blender の「マテリアル」) ---
// 材質ごとに、表示・色・不透明度・環境色・反射・輪郭線を変える。最初に変えたときの値を覚えておき、元に戻せる
export class Materials {
  constructor(private viewport: Viewport, private ui: UiChannel) {}

  private all(obj: ModelObj): Any[] { return [obj.model.material].flat(); }
  // MMD の材質は色を diffuse に、ほかの材質は color に持っている
  private colorOf(m: Any): THREE.Color { return m.diffuse ?? m.color; }

  list(obj: ModelObj): MaterialItem[] {
    return this.all(obj).map((m, index) => ({ index, name: m.name || `材質 ${index + 1}`, visible: m.visible, edited: !!m.userData.materialOriginal }));
  }

  get(obj: ModelObj, i: number): MaterialProps | null {
    const m = this.all(obj)[i];
    if (!m) return null;
    const edge = outlineOf(m);
    return {
      name: m.name || `材質 ${i + 1}`,
      visible: m.visible,
      diffuse: hexOf(this.colorOf(m)),
      opacity: m.opacity,
      ambient: hexOf(m.emissive ?? _c.set(0)),
      specular: hexOf(m.specular ?? _c.set(0)),
      shininess: m.shininess ?? 0,
      edgeVisible: !!edge.visible,
      edgeColor: edgeHex(edge.color ?? [0, 0, 0]),
      edgeSize: (edge.thickness ?? 0) * EDGE_SCALE,
    };
  }

  set(obj: ModelObj, i: number, patch: Partial<Omit<MaterialProps, 'name'>>) {
    const m = this.all(obj)[i];
    if (!m) return;
    m.userData.materialOriginal ??= this.get(obj, i); // 最初に変えるときの値を覚えておく
    const original: MaterialProps = m.userData.materialOriginal;
    if (patch.visible !== undefined) m.visible = patch.visible;
    if (patch.diffuse !== undefined) this.colorOf(m).set(patch.diffuse);
    if (patch.opacity !== undefined) {
      m.opacity = patch.opacity;
      // 透けるときだけ半透明として描く (元から半透明の材質はそのまま)
      const transparent = patch.opacity < 1 || original.opacity < 1;
      if (m.transparent !== transparent) { m.transparent = transparent; m.needsUpdate = true; }
    }
    if (patch.ambient !== undefined && m.emissive) {
      m.emissive.set(patch.ambient);
      if (m.userData.baseEmissive) m.userData.baseEmissive.copy(m.emissive); // 掴んで明るくするときの元の色も
    }
    if (patch.specular !== undefined && m.specular) m.specular.set(patch.specular);
    if (patch.shininess !== undefined && m.shininess !== undefined) m.shininess = patch.shininess;
    if (patch.edgeVisible !== undefined || patch.edgeColor !== undefined || patch.edgeSize !== undefined) {
      const edge = { ...outlineOf(m) };
      if (patch.edgeVisible !== undefined) edge.visible = patch.edgeVisible;
      if (patch.edgeColor !== undefined) edge.color = edgeArray(patch.edgeColor);
      if (patch.edgeSize !== undefined) edge.thickness = patch.edgeSize / EDGE_SCALE;
      this.setOutline(obj, m, edge);
    }
    this.changed();
  }

  // 1 つの材質を、最初に変える前の値に戻す
  reset(obj: ModelObj, i: number) {
    const m = this.all(obj)[i];
    const original: MaterialProps | undefined = m?.userData.materialOriginal;
    if (!original) return;
    const { name: _name, ...props } = original;
    void _name;
    this.set(obj, i, props);
    delete m.userData.materialOriginal;
    this.changed();
  }
  resetAll(obj: ModelObj) {
    this.all(obj).forEach((_, i) => this.reset(obj, i));
  }

  private setOutline(obj: ModelObj, m: Any, edge: Any) {
    if (m.userData.baseOutline) {
      // 選んでいるあいだの輪郭線 (オレンジ) は、次に描くときに元の設定から作り直す
      m.userData.baseOutline = edge;
      if (obj.outlined) obj.outlined = undefined;
      else m.userData.outlineParameters = { ...edge };
    } else {
      m.userData.outlineParameters = edge;
    }
  }
  private changed() {
    this.ui.bump('values');
    this.viewport.requestDraw();
  }
}
