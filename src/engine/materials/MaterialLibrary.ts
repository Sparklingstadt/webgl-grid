import * as THREE from 'three';
import { t } from '../../core/i18n';
import { Emitter } from '../../core/events';
import { generate, type ShaderCode, type UniformSpec } from '../../core/materials/glsl';
import type { Color3 } from '../../core/materials/nodes';
import { cloneTree, createTree, findNode, type NodeTree } from '../../core/materials/tree';

// --- マテリアル (Blender のマテリアルのデータ) ---
// 名前を持ち、複数の物 (のマテリアルスロット) で共有できる。中身はシェーダーのノードツリーと、描き方の設定。
// 描くときは、使う物ごとに three.js の材質 (インスタンス) を作り、ノードツリーから組み立てたシェーダーを差し込む
export interface MaterialSettings {
  blend: 'opaque' | 'blend' | 'clip'; // 不透明 / アルファブレンド / アルファクリップ
  backfaceCulling: boolean;           // 裏面を表示しない
}
// MMD の輪郭線 (OutlineEffect)。色は OutlineEffect に渡す値そのまま、太さは MMD のエッジサイズ
export interface MaterialOutline { enabled: boolean; color: Color3; size: number }
// MMD の .pmx から変換したときの元の値 (.pmx に書き出すとき、プリンシプル BSDF で表せない値に使う)
export interface MmdSource {
  diffuse: [number, number, number, number]; specular: Color3; shininess: number; ambient: Color3;
  edge: boolean; edgeColor: [number, number, number, number]; edgeSize: number;
}
export interface MaterialData {
  id: string;
  name: string;
  tree: NodeTree;
  settings: MaterialSettings;
  outline: MaterialOutline;
  mmd?: MmdSource;
  auto?: boolean; // 形を置いたときに自動で作り、まだ手を入れていない (使う物がなくなったら消す)
}
export interface ImageData { id: string; name: string; texture: THREE.Texture; file?: File } // file: 開いた画像ファイル (プロジェクトに入れる)
export interface MaterialListItem { id: string; name: string; users: number }

const DEFAULT_SETTINGS: MaterialSettings = { blend: 'opaque', backfaceCulling: false };
const DEFAULT_OUTLINE: MaterialOutline = { enabled: false, color: [0, 0, 0], size: 1 };

export class MaterialLibrary {
  readonly materials = new Map<string, MaterialData>();
  readonly images = new Map<string, ImageData>();
  readonly events = new Emitter<{ changed: [] }>();
  private instances = new Map<string, Set<THREE.MeshPhysicalMaterial>>();
  private nextId = 1;
  private fallback: THREE.MeshPhysicalMaterial | null = null;

  // Blender と同じく、同じ名前があれば「.001」などを付ける
  uniqueName(base: string, except?: string) {
    const taken = new Set([...this.materials.values()].filter(m => m.id !== except).map(m => m.name));
    if (!taken.has(base)) return base;
    const stem = base.replace(/\.\d{3}$/, '');
    for (let i = 1; ; i++) {
      const name = `${stem}.${String(i).padStart(3, '0')}`;
      if (!taken.has(name)) return name;
    }
  }

  create(name = t('マテリアル'), init: Partial<Omit<MaterialData, 'id' | 'name'>> = {}): MaterialData {
    const data: MaterialData = {
      id: `m${this.nextId++}`, name: this.uniqueName(name),
      tree: init.tree ?? createTree(),
      settings: { ...DEFAULT_SETTINGS, ...init.settings },
      outline: { ...DEFAULT_OUTLINE, ...init.outline },
      mmd: init.mmd, auto: init.auto,
    };
    this.materials.set(data.id, data);
    this.instances.set(data.id, new Set());
    this.changed();
    return data;
  }
  duplicate(id: string): MaterialData | null {
    const src = this.materials.get(id);
    if (!src) return null;
    return this.create(src.name, { tree: cloneTree(src.tree), settings: { ...src.settings }, outline: { ...src.outline, color: [...src.outline.color] }, mmd: src.mmd });
  }
  rename(id: string, name: string) {
    const data = this.materials.get(id);
    if (!data || !name.trim()) return;
    data.name = this.uniqueName(name.trim(), id);
    data.auto = false; // 名前を付けたものは、使う物がなくなっても残す
    this.changed();
  }
  // 使っている物がなければ消す
  remove(id: string) {
    if (this.users(id) > 0) return false;
    this.materials.delete(id);
    this.instances.delete(id);
    this.changed();
    return true;
  }
  users(id: string) { return this.instances.get(id)?.size ?? 0; }
  // すべてのマテリアルと画像を消す (プロジェクトを開くとき。物はすでに片付けてあること)
  reset() {
    this.materials.clear();
    this.images.clear();
    this.instances.clear();
    this.changed();
  }
  // --- 元に戻す (History) ---
  // すべてのマテリアルの写し (使っている材質の数は含まない)
  snapshot(): MaterialData[] { return [...this.materials.values()].map(m => structuredClone(m)); }
  // 写しのとおりにする: あるものは中身を入れ替え、ないものは同じ id で作り直す (余ったものは prune で消す)
  restore(list: MaterialData[]) {
    for (const src of list) {
      const data = structuredClone(src);
      const cur = this.materials.get(data.id);
      if (cur) {
        Object.assign(cur, data);
        if (!('mmd' in data)) delete cur.mmd;
        if (!('auto' in data)) delete cur.auto;
        for (const m of this.instances.get(data.id) ?? []) this.apply(data.id, m, false);
      } else {
        this.materials.set(data.id, data);
        this.instances.set(data.id, new Set());
      }
      const n = Number(data.id.slice(1));
      if (Number.isFinite(n) && n >= this.nextId) this.nextId = n + 1;
    }
    this.changed();
  }
  // keep にない、使っている物のないマテリアルを消す
  prune(keep: Set<string>) {
    for (const id of [...this.materials.keys()]) if (!keep.has(id)) this.remove(id);
  }
  list(): MaterialListItem[] { return [...this.materials.values()].map(m => ({ id: m.id, name: m.name, users: this.users(m.id) })); }

  // 画像 (同じテクスチャは 1 つにまとめる)
  addImage(name: string, texture: THREE.Texture, file?: File): ImageData {
    for (const img of this.images.values()) if (img.texture === texture) return img;
    const img = { id: `i${this.nextId++}`, name, texture, file };
    this.images.set(img.id, img);
    this.changed();
    return img;
  }

  // 物のスロットで使う three.js の材質を作る。material が null なら、マテリアルなしの灰色
  instance(id: string | null): THREE.MeshPhysicalMaterial {
    if (!id || !this.materials.has(id)) {
      this.fallback ??= Object.assign(new THREE.MeshPhysicalMaterial({ color: 0xcccccc, roughness: 0.5 }), { userData: { outlineBase: { visible: false } } });
      return this.fallback;
    }
    const m = new THREE.MeshPhysicalMaterial();
    m.userData.materialId = id;
    this.instances.get(id)!.add(m);
    this.apply(id, m, true);
    this.changed();
    return m;
  }
  // 物を消すとき・スロットを替えるときに、作った材質を返す
  release(m: THREE.Material) {
    const id = m.userData.materialId;
    if (!id || !this.instances.get(id)?.delete(m as THREE.MeshPhysicalMaterial)) return;
    m.dispose();
    const data = this.materials.get(id);
    if (data?.auto && this.users(id) === 0) this.remove(id); // 自動で作っただけのマテリアルは片付ける
    this.changed();
  }
  // root の中のメッシュが使っている材質を、すべて返す
  releaseAll(root: THREE.Object3D) {
    root.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) for (const m of [mesh.material].flat()) this.release(m);
    });
  }

  // マテリアルを変える。fn のあと、使っている材質すべてに反映する
  edit(id: string, fn: (data: MaterialData) => void) {
    const data = this.materials.get(id);
    if (!data) return;
    fn(data);
    data.auto = false;
    for (const m of this.instances.get(id) ?? []) this.apply(id, m, false);
    this.changed();
  }

  // ノードツリーからシェーダーを組み立てて材質に入れる。形が同じなら uniform の値だけ入れ替える
  private apply(id: string, m: THREE.MeshPhysicalMaterial, force: boolean) {
    const data = this.materials.get(id)!;
    const code = generate(data.tree, img => this.images.has(img));
    const same = !force && m.userData.nodeKey === code.key;
    if (same) {
      for (const u of code.uniforms) m.userData.nodeUniforms[u.name].value = this.uniformValue(data.tree, u);
    } else {
      const uniforms: Record<string, THREE.IUniform> = {};
      for (const u of code.uniforms) uniforms[u.name] = { value: this.uniformValue(data.tree, u) };
      m.userData.nodeUniforms = uniforms;
      m.userData.nodeKey = code.key;
      injectShader(m, code, uniforms);
    }
    this.applyStatic(m, data, code, !same);
  }
  private uniformValue(tree: NodeTree, u: UniformSpec) {
    const node = findNode(tree, u.node)!;
    if (u.kind === 'sampler') return this.images.get(node.props.image)?.texture ?? null;
    const v = node.values[u.socket];
    return u.kind === 'float' ? (v as number) : new THREE.Vector3(...(v as Color3));
  }
  // つなげない値・法線マップ・描き方の設定・輪郭線
  private applyStatic(m: THREE.MeshPhysicalMaterial, data: MaterialData, code: ShaderCode, rebuilt: boolean) {
    const c = code.constants;
    m.ior = c.ior;
    m.specularIntensity = c.specular * 2; // Blender の 0.5 が three.js の 1 (F0 = 0.04)
    m.transmission = c.transmission;
    m.clearcoat = c.coat;
    m.clearcoatRoughness = c.coatRoughness;
    m.sheen = c.sheen;
    const nm = code.normalMap;
    const normalMap = nm ? this.images.get(nm.image)?.texture ?? null : null;
    const strength = nm ? (findNode(data.tree, nm.node)?.values.strength as number ?? 1) : 1;
    if (m.normalMap !== normalMap) { m.normalMap = normalMap; rebuilt = true; }
    m.normalScale.set(strength, strength);
    const s = data.settings;
    const transparent = s.blend === 'blend', alphaTest = s.blend === 'clip' ? 0.5 : 0;
    const side = s.backfaceCulling ? THREE.FrontSide : THREE.DoubleSide;
    if (m.transparent !== transparent || m.alphaTest !== alphaTest || m.side !== side) rebuilt = true;
    Object.assign(m, { transparent, alphaTest, side });
    const o = data.outline;
    m.userData.outlineBase = { visible: o.enabled && o.size > 0, color: [...o.color], alpha: 1, thickness: o.size / 300 };
    if (rebuilt) m.needsUpdate = true;
  }
  private changed() { this.events.emit('changed'); }
}

// MeshPhysicalMaterial のシェーダーに、ノードから作った式を差し込む
function injectShader(m: THREE.MeshPhysicalMaterial, code: ShaderCode, uniforms: Record<string, THREE.IUniform>) {
  m.defines = { ...m.defines, USE_UV: '' }; // vUv を使う
  m.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${code.decls}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${code.body}\ndiffuseColor = vec4(${code.base}, ${code.alpha});`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = ${code.roughness};`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nmetalnessFactor = ${code.metallic};`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += ${code.emission};`);
  };
  m.customProgramCacheKey = () => code.key;
}
