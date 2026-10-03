import * as THREE from 'three';
import type { Color3 } from '../../core/materials/nodes';
import { findNode, inputLink, surfaceShader } from '../../core/materials/tree';
import type { PmxMaterialValues } from '../../core/pmxMaterials';
import type { MaterialData, MmdSource } from './MaterialLibrary';

const toSrgb = (c: Color3): Color3 => {
  const o = { r: 0, g: 0, b: 0 };
  new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace).getRGB(o, THREE.SRGBColorSpace);
  return [o.r, o.g, o.b];
};

// --- マテリアルを、.pmx の材質の値に戻す (MMD で表せる範囲で) ---
//   ベースカラー: つながっていなければその色。「画像 × 色 (乗算)」なら掛ける色、画像だけなら白
//   アルファ: つながっていなければその値。「画像のアルファ × 値 (乗算)」ならその値、画像のアルファだけなら 1
//   粗さ → 反射の強さ。輪郭線 → エッジ。反射色・環境色は元の値のまま
//   ほかのつなぎ方 (MMD で表せないもの) は、元の .pmx の値を使う
export function toPmxValues(data: MaterialData | null, src: MmdSource): PmxMaterialValues {
  const v: PmxMaterialValues = {
    diffuse: [...src.diffuse], specular: [...src.specular], specularPower: src.shininess, ambient: [...src.ambient],
    edge: src.edge, edgeColor: [...src.edgeColor], edgeSize: src.edgeSize,
  };
  if (!data) return v;
  const tree = data.tree, bsdf = surfaceShader(tree);
  if (bsdf) {
    const from = (socket: string) => {
      const l = inputLink(tree, bsdf.id, socket);
      return l ? { node: findNode(tree, l.from.node)!, socket: l.from.socket } : null;
    };
    const base = from('baseColor');
    let rgb: Color3 | null = null;
    if (!base) rgb = toSrgb(bsdf.values.baseColor as Color3);
    else if (base.node.type === 'image') rgb = [1, 1, 1];
    else if (base.node.type === 'mix' && base.node.props.blend === 'multiply') {
      const a = inputLink(tree, base.node.id, 'a'), b = inputLink(tree, base.node.id, 'b');
      const imgA = a && findNode(tree, a.from.node)?.type === 'image', imgB = b && findNode(tree, b.from.node)?.type === 'image';
      if (imgA && !b) rgb = toSrgb(base.node.values.b as Color3);
      else if (imgB && !a) rgb = toSrgb(base.node.values.a as Color3);
    }
    if (rgb) v.diffuse = [rgb[0], rgb[1], rgb[2], v.diffuse[3]];
    const alpha = from('alpha');
    if (!alpha) v.diffuse[3] = bsdf.values.alpha as number;
    else if (alpha.node.type === 'image') v.diffuse[3] = 1;
    else if (alpha.node.type === 'math' && alpha.node.props.op === 'multiply' && !inputLink(tree, alpha.node.id, 'b')) v.diffuse[3] = alpha.node.values.b as number;
    if (!from('roughness')) {
      const r = Math.max(bsdf.values.roughness as number, 0.05);
      v.specularPower = Math.max(2 / (r * r) - 2, 0);
    }
  }
  v.edge = data.outline.enabled;
  v.edgeColor = [...data.outline.color, v.edgeColor[3]];
  v.edgeSize = data.outline.size;
  return v;
}
