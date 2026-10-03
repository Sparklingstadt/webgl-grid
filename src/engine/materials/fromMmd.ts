import * as THREE from 'three';
import type { Color3 } from '../../core/materials/nodes';
import { addNode, connect, createTree, surfaceShader } from '../../core/materials/tree';
import type { Any } from '../types';
import type { MaterialLibrary, MmdSource } from './MaterialLibrary';

const srgb = (c: THREE.Color): Color3 => { const o = { r: 0, g: 0, b: 0 }; c.getRGB(o, THREE.SRGBColorSpace); return [o.r, o.g, o.b]; };
const linear = (c: THREE.Color): Color3 => [c.r, c.g, c.b];
const isWhite = (c: Color3) => c.every(v => v > 0.999);
// ファイル名の比較用 (MmdLoader と同じ: パスの最後の名前を、小文字・NFC で)
const fileKey = (path: string) => decodeURIComponent(path).replace(/\\/g, '/').split('/').pop()!.normalize('NFC').toLowerCase();

// --- MMD の材質 (MMDLoader の MMDToonMaterial) を、プリンシプル BSDF のマテリアルに変換する ---
//   テクスチャ → 画像テクスチャ。色が白でなければ、乗算のミックスで掛け合わせてベースカラーへ
//   半透明 (テクスチャのアルファ) → アルファ。不透明度が 1 未満なら、数式 (乗算) で掛け合わせる
//   反射の強さ (shininess) → 粗さ。反射色 → スペキュラー IOR レベル。トゥーン・スフィアマップは使わない
//   輪郭線・両面表示・半透明は、マテリアルの設定に移す
//   見つからなかったテクスチャ (missing: ファイル名を小文字にしたもの) は使わず、色だけにする (読めない画像は黒く写るので)
export function convertMmdMaterial(toon: Any, lib: MaterialLibrary, label: string, missing?: Set<string>) {
  const tree = createTree();
  const bsdf = surfaceShader(tree)!;
  const diffuse: THREE.Color = toon.diffuse ?? toon.color;
  const baseLinear = linear(diffuse);
  const mapFile: string | undefined = toon.userData?.MMD?.mapFileName;
  if (toon.map && !(mapFile && missing?.has(fileKey(mapFile)))) {
    const img = lib.addImage(toon.map.name || `${label} のテクスチャ`, toon.map);
    const tex = addNode(tree, 'image', -760, -40);
    tex.props.image = img.id;
    if (isWhite(srgb(diffuse))) {
      connect(tree, { node: tex.id, socket: 'color' }, { node: bsdf.id, socket: 'baseColor' });
    } else {
      const mix = addNode(tree, 'mix', -520, -40);
      mix.props.blend = 'multiply';
      mix.values.factor = 1;
      mix.values.b = baseLinear;
      connect(tree, { node: tex.id, socket: 'color' }, { node: mix.id, socket: 'a' });
      connect(tree, { node: mix.id, socket: 'result' }, { node: bsdf.id, socket: 'baseColor' });
    }
    if (toon.transparent) {
      if (toon.opacity < 1) {
        const math = addNode(tree, 'math', -520, 180);
        math.props.op = 'multiply';
        math.values.b = toon.opacity;
        connect(tree, { node: tex.id, socket: 'alpha' }, { node: math.id, socket: 'a' });
        connect(tree, { node: math.id, socket: 'value' }, { node: bsdf.id, socket: 'alpha' });
      } else {
        connect(tree, { node: tex.id, socket: 'alpha' }, { node: bsdf.id, socket: 'alpha' });
      }
    }
  } else {
    bsdf.values.baseColor = baseLinear;
  }
  const specular = srgb(toon.specular ?? new THREE.Color(0));
  bsdf.values.alpha = toon.opacity;
  bsdf.values.roughness = Math.min(Math.max(Math.sqrt(2 / ((toon.shininess ?? 0) + 2)), 0.05), 1);
  bsdf.values.specular = 0.5 * Math.min(Math.max(...specular) / 0.5, 1);
  const edge = toon.userData.outlineParameters ?? { visible: false, thickness: 0, color: [0, 0, 0], alpha: 1 };
  const ambient = srgb(toon.emissive ?? new THREE.Color(0)).map(v => (toon.map ? v / 0.2 : v)) as Color3; // MMDLoader はテクスチャがあると 0.2 倍している
  const mmd: MmdSource = {
    diffuse: [...srgb(diffuse), toon.opacity], specular, shininess: toon.shininess ?? 0, ambient,
    edge: !!edge.visible, edgeColor: [...edge.color, edge.alpha ?? 1] as MmdSource['edgeColor'], edgeSize: (edge.thickness ?? 0) * 300,
  };
  return lib.create(toon.name || label, {
    tree,
    settings: { blend: toon.transparent ? 'blend' : 'opaque', backfaceCulling: toon.side === THREE.FrontSide },
    outline: { enabled: !!edge.visible, color: [...edge.color] as Color3, size: (edge.thickness ?? 0) * 300 },
    mmd,
  });
}

// MMD のメッシュの材質をすべて変換し、変換したマテリアルの材質に差し替える。スロットのマテリアルの id を返す
export function convertMmdMesh(mesh: Any, lib: MaterialLibrary): string[] {
  const toons: Any[] = [mesh.material].flat();
  const before = new Set(lib.images.keys());
  const ids = toons.map((t, i) => convertMmdMaterial(t, lib, `${mesh.name || 'モデル'} ${i + 1}`, mesh.userData.missingTextures).id);
  // 変換で作った画像 (作った順)。プロジェクトを開くとき、同じ順に作り直した画像と対応づける
  mesh.userData.convertedImages = [...lib.images.keys()].filter(id => !before.has(id));
  const instances = ids.map(id => lib.instance(id));
  mesh.material = Array.isArray(mesh.material) ? instances : instances[0];
  mesh.userData.slotSources = ids.map(id => lib.materials.get(id)!.mmd); // .pmx に書き出すときの元の値
  for (const t of toons) t.dispose(); // テクスチャは画像として残す
  return ids;
}
