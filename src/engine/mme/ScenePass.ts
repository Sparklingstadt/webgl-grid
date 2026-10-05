import * as THREE from 'three';
import type { Pass } from '../../core/fx/index.ts';
import { t } from '../../core/i18n';
import type { Color3 } from '../../core/materials/nodes';
import { inputLink, surfaceShader, upstreamOrder } from '../../core/materials/tree';
import type { ControlRef } from '../../core/mme/controllers.ts';
import { runTechnique } from '../../core/mme/script.ts';
import { SHADOW_COLOR, type MaterialState, type MmdPass, type SemanticContext } from '../../core/mme/semantics.ts';
import type { MmeSettings } from '../../core/mme/settings.ts';
import { pickTechnique, type TechniqueQuery } from '../../core/mme/technique.ts';
import { mmeTexturesOf } from '../materials/fromMmd';
import type { MaterialData, MaterialLibrary } from '../materials/MaterialLibrary';
import type { SceneGraph } from '../render/SceneGraph';
import type { Obj } from '../types';
import type { World } from '../world/World';
import type { BaseState, EffectInstance, TextureSource } from './EffectInstance';
import type { LoadedEffect } from './EffectStore';
import type { DrawTarget, Framebuffers } from './Framebuffers';
import { mmdSourceOf, type MmdData } from './mmdData';
import { builtins, ScriptTargets, type FrameState } from './PostChain';
import type { MmeGeometry, Skinner } from './Skinner';

// --- 場面を描く: 表 (どの物・材質をどのエフェクトで描くか) のとおりに、ステージと置いた物を、モデルごとに
// 地面の影・本体・輪郭線の順で描く。セルフシャドウの深度マップ (zplot) も描く。Main の表とオフスクリーンの表で使う ---

// 材質の部分を描くもの: エフェクトか、描かない (hide)
export type Slot = { kind: 'effect'; effect: LoadedEffect } | { kind: 'hide' };
export type SlotFor = (obj: Obj | null /* ステージは null */, mesh: THREE.Mesh, materialIndex: number) => Slot;
export interface PassTable {
  name: string; // 'Main' かオフスクリーンの名前
  slotFor: SlotFor;
  owner: Obj | null; // 入れ子のオフスクリーンの持ち主 ((OffscreenOwner)。SemanticContext.owner に渡す)
}
// その表で描く物と、そのエフェクト (オフスクリーンを先に描くため)
export interface TableUse { obj: Obj | null; effect: LoadedEffect }

export interface ScenePassDeps {
  graph: SceneGraph; world: World; library: MaterialLibrary; settings: MmeSettings;
  stage(): THREE.Object3D | null;
  renderer(): THREE.WebGLRenderer; // (描くときだけ呼ぶ)
  outputting(): boolean; // 書き出し中 (書き出しで隠す物を除く)
  requestDraw(): void;
  toast(message: string): void; // エフェクトを GPU で止めたお知らせ
  defaultEffect: LoadedEffect; // technique がないときに代わりに使う
  fb(): Framebuffers;
  instance(e: LoadedEffect): EffectInstance;
  skinner(): Skinner;
  shadowMap(): THREE.Texture | null; // セルフシャドウの深度マップ
  // エフェクトが宣言したオフスクリーンのテクスチャ (owner はそのエフェクトで描く物。描いていなければ null)
  offscreen(effect: LoadedEffect, name: string, owner: Obj | null): THREE.Texture | null;
  warn(message: string): void; // どのエフェクトのものでもない警告
  control(ref: ControlRef, self: Obj | null, owner: Obj | null): number[] | null; // CONTROLOBJECT の値 (self はいま描いている物)
}

// PMX の材質のフラグ
const DOUBLE_SIDED = 0x01, GROUND_SHADOW = 0x02, CAST_SELF_SHADOW = 0x04, RECEIVE_SELF_SHADOW = 0x08, EDGE = 0x10;

interface SubsetTextures { material: THREE.Texture | null; sphere: THREE.Texture | null; toon: THREE.Texture | null }
// 材質の部分 (サブセット)。index は材質の番号 (technique の Subset と照らす)。group が null なら形全体。flags は PMX の材質のフラグ
export interface Subset {
  index: number; group: THREE.GeometryGroup | null; state: MaterialState; flags: number; doubleSided: boolean; textures: SubsetTextures;
}
// 描く物 (メッシュ 1 つ) と、1 フレームの値。obj は置いた物 (ステージは null)
export interface DrawItem { obj: Obj | null; mesh: THREE.Mesh; geo: MmeGeometry; subsets: Subset[] }
// その表で描く材質の部分と、そのエフェクト
interface Part { sub: Subset; effect: LoadedEffect }
interface Toon { tex: THREE.DataTexture; color: Color3; version: number }

const WHITE: Color3 = [1, 1, 1];

// 祖先まで見えているか
function visibleChain(o: THREE.Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}

export function toSrgb(c: THREE.Color): Color3 {
  const o = { r: 0, g: 0, b: 0 };
  c.getRGB(o, THREE.SRGBColorSpace);
  return [o.r, o.g, o.b];
}

// マテリアルのベースカラーにつながっている画像 (なければ null)
function baseImage(lib: MaterialLibrary, data: MaterialData): THREE.Texture | null {
  const bsdf = surfaceShader(data.tree);
  const link = bsdf && inputLink(data.tree, bsdf.id, 'baseColor');
  if (!link) return null;
  for (const n of upstreamOrder(data.tree, link.from.node)) {
    if (n.type !== 'image') continue;
    const img = lib.images.get(String(n.props.image));
    if (img) return img.texture;
  }
  return null;
}

// MMDLoader はトゥーンの画像を three.js のグラデーション用に 90° 回して (上の行が右の列に) 持っているので、元の向きに戻す。
// color はいちばん下の行の色 (TOONCOLOR)。画像はガンマ空間のまま
function unrotateToon(img: { data: ArrayLike<number>; width: number; height: number }): { tex: THREE.DataTexture; color: Color3 } {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 元の (x, y) は、回した画像の (w/2 − (y − h/2), h/2 + (x − w/2)) にある (画素の中心で)
      const rx = Math.min(Math.max(Math.floor(w / 2 - (y + 0.5 - h / 2)), 0), w - 1);
      const ry = Math.min(Math.max(Math.floor(h / 2 + (x + 0.5 - w / 2)), 0), h - 1);
      for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = data[(ry * w + rx) * 4 + k];
    }
  }
  const tex = new THREE.DataTexture(out, w, h);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;
  const b = (h - 1) * w * 4;
  return { tex, color: [out[b] / 255, out[b + 1] / 255, out[b + 2] / 255] };
}

function isMmd(o: THREE.Object3D): boolean {
  const m = o as THREE.SkinnedMesh;
  return m.isSkinnedMesh === true && (mmdSourceOf(m.geometry) !== undefined || 'sourceFile' in m.userData);
}

export class ScenePass {
  private items: DrawItem[] = []; // frameNo のフレームの描く物
  private frameNo: number | null = null;
  private toons = new Map<THREE.Texture, Toon>(); // 元のトゥーンの画像ごと (場面にないモデルのものは prune で捨てる)
  private proxy = new THREE.Mesh(); // renderBufferDirect に渡す物 (単位行列。three.js の骨やモーフ・面の反転を効かせない)
  private linked = new WeakSet<THREE.Material>(); // リンクできたかを確かめた材質

  constructor(private d: ScenePassDeps) {}

  // 表のとおりに場面を描く。描画先はいまのもの (ポストエフェクトは ScriptExternal からここを呼ぶ)。
  // 物の .fx の Script が「既定の描画先」と言ったら、いまの描画先 (three.js の render の中で呼ぶ)
  draw(table: PassTable, frame: FrameState, target: DrawTarget): void {
    const fb = this.d.fb();
    const outer = fb.defaultSurface;
    fb.defaultSurface = fb.current;
    // 地面の影のステンシルを 0 から始める (Script が Clear=Depth しない深度のターゲットでも、物を描く前に消す)
    fb.clear(null, null, 0);
    try {
      this.drawItems(table, frame, target);
    } finally {
      fb.defaultSurface = outer;
    }
  }

  // セルフシャドウの深度マップ: 影を落とす材質の部分を、いまの描画先に zplot で描く (three.js の render の中で呼ぶ)
  drawSelfShadow(table: PassTable, frame: FrameState, target: DrawTarget): void {
    for (const item of this.collect(frame)) {
      for (const { sub, effect } of this.parts(table, item)) if (sub.flags & CAST_SELF_SHADOW) this.drawPass(table, effect, item, sub, 'zplot', frame, target);
    }
  }

  // そのフレームに描く形 (three.js の render の前に GPU に送らせる)
  geometries(frame: FrameState): THREE.BufferGeometry[] {
    const out: THREE.BufferGeometry[] = [];
    for (const it of this.collect(frame)) {
      out.push(it.geo.geometry);
      if (it.geo.edge) out.push(it.geo.edge);
    }
    return out;
  }

  // その表で、そのフレームに描く物とエフェクトの組 (描く順に、1 つずつ)
  uses(table: PassTable, frame: FrameState): TableUse[] {
    const out: TableUse[] = [];
    const seen = new Map<Obj | null, Set<LoadedEffect>>();
    for (const item of this.collect(frame)) {
      let effects = seen.get(item.obj);
      if (!effects) seen.set(item.obj, (effects = new Set()));
      for (const { effect } of this.parts(table, item)) {
        if (effects.has(effect)) continue;
        effects.add(effect);
        out.push({ obj: item.obj, effect });
      }
    }
    return out;
  }

  // MMD モデルの .pmx の読み込みが終わる (失敗しても) まで待つ
  async whenReady(): Promise<void> {
    const waits: Promise<void>[] = [];
    const skinner = this.d.skinner();
    const visit = (root: THREE.Object3D) => root.traverse(o => {
      if (isMmd(o)) waits.push(skinner.settled(o as THREE.SkinnedMesh));
    });
    for (const obj of this.d.world.objects) visit(obj.node);
    const stage = this.d.stage();
    if (stage) visit(stage);
    await Promise.all(waits);
  }

  // 置いた物とステージの材質が使っていないトゥーンの画像を捨てる
  prune(): void {
    if (this.toons.size === 0) return;
    const live = new Set<THREE.Texture>();
    const visit = (root: THREE.Object3D) => root.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const toon = m && mmeTexturesOf(m)?.toon;
        if (toon) live.add(toon);
      }
    });
    for (const obj of this.d.world.objects) visit(obj.node);
    const stage = this.d.stage();
    if (stage) visit(stage);
    for (const [src, toon] of this.toons) {
      if (live.has(src)) continue;
      toon.tex.dispose();
      this.toons.delete(src);
    }
  }

  // トゥーンの画像と、集めた描く物を捨てる (次に描くときに作り直す)
  dispose(): void {
    for (const toon of this.toons.values()) toon.tex.dispose();
    this.toons.clear();
    this.items = [];
    this.frameNo = null;
  }

  // 材質で初めて描いたあとに、シェーダーをリンクできたかを確かめる。できなければ、そのエフェクトを止めてお知らせを 1 回出す
  checkLink(m: THREE.Material, inst: EffectInstance, effect: LoadedEffect): void {
    if (this.linked.has(m)) return;
    this.linked.add(m);
    const renderer = this.d.renderer();
    const program = (renderer.properties.get(m) as { currentProgram?: { program?: WebGLProgram } }).currentProgram?.program;
    const gl = renderer.getContext();
    if (!program || gl.getProgramParameter(program, gl.LINK_STATUS) !== false) return;
    inst.stopped = true;
    this.d.toast(t('{name} のシェーダーを GPU で使えないので止めました', { name: effect.name }));
    this.d.requestDraw();
  }

  // モデルを並べた順に: 地面の影 → 本体 → 輪郭線
  private drawItems(table: PassTable, frame: FrameState, target: DrawTarget): void {
    const { groundShadow } = this.d.settings;
    for (const item of this.collect(frame)) {
      const parts = this.parts(table, item);
      if (groundShadow) for (const { sub, effect } of parts) if (sub.flags & GROUND_SHADOW) this.drawPass(table, effect, item, sub, 'shadow', frame, target);
      for (const { sub, effect } of parts) {
        this.drawPass(table, effect, item, sub, frame.selfShadow && sub.flags & RECEIVE_SELF_SHADOW ? 'object_ss' : 'object', frame, target);
      }
      if (item.geo.edge) for (const { sub, effect } of parts) if (sub.flags & EDGE) this.drawPass(table, effect, item, sub, 'edge', frame, target);
    }
  }

  // その表で描く材質の部分 (hide の部分を除く)
  private parts(table: PassTable, item: DrawItem): Part[] {
    const out: Part[] = [];
    for (const sub of item.subsets) {
      const slot = table.slotFor(item.obj, item.mesh, sub.index);
      if (slot.kind === 'effect') out.push({ sub, effect: slot.effect });
    }
    return out;
  }

  // --- 描く物 ---
  // ステージ (背景として先に描く。モデルの地面の影が床に重なるように) と、置いた物 (見えているもの) の見えているメッシュ。
  // 編集用の物 (editorOnly) は除く。1 フレームに 1 回だけ集める
  private collect(frame: FrameState): DrawItem[] {
    if (this.frameNo === frame.frameNo) return this.items;
    const items: DrawItem[] = [];
    const stage = this.d.stage();
    if (stage && visibleChain(stage)) this.collectFrom(stage, null, frame, items);
    const outputting = this.d.outputting();
    for (const obj of this.d.world.objects) {
      if (outputting ? obj.hideRender : obj.hidden || obj.colHidden) continue;
      if (visibleChain(obj.node)) this.collectFrom(obj.node, obj, frame, items);
    }
    this.items = items;
    this.frameNo = frame.frameNo;
    return items;
  }

  private collectFrom(root: THREE.Object3D, obj: Obj | null, frame: FrameState, items: DrawItem[]): void {
    const visit = (o: THREE.Object3D) => {
      if (!o.visible || o.userData.editorOnly) return;
      if ((o as THREE.Mesh).isMesh) {
        const item = this.item(o as THREE.Mesh, obj, frame);
        if (item) items.push(item);
      }
      for (const c of o.children) visit(c);
    };
    visit(root);
  }

  private item(mesh: THREE.Mesh, obj: Obj | null, frame: FrameState): DrawItem | null {
    const skinner = this.d.skinner();
    if (!isMmd(mesh)) return { obj, mesh, geo: skinner.plain(mesh), subsets: this.subsets(mesh, null) };
    const sm = mesh as THREE.SkinnedMesh;
    // クローンは userData の File を失う。形が差し替わった (デフォーマで変形した) クローンは .pmx を引けない
    if (!(mmdSourceOf(sm.geometry) ?? (sm.userData.sourceFile instanceof Blob))) {
      this.d.warn(t('{name}: 元の .pmx が分からないので描けません (デフォーマで変形したモデルの複製)', { name: sm.name || t('MMD モデル') }));
      return null;
    }
    // .pmx を読み終えていなければ、このフレームは描かない (読み終えたら描き直す)
    const geo = skinner.mmd(sm, frame.eye, Math.tan(frame.camera.fovY / 2), () => this.d.requestDraw(), frame.frameNo);
    const data = skinner.data(sm);
    if (!geo || !data) {
      if (skinner.failed(sm)) this.d.warn(t('{name}: .pmx を読めないので描けません', { name: sm.name || t('MMD モデル') }));
      return null;
    }
    return { obj, mesh, geo, subsets: this.subsets(mesh, data) };
  }

  // 材質の部分。材質が 1 つなら形全体
  private subsets(mesh: THREE.Mesh, data: MmdData | null): Subset[] {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups: (THREE.GeometryGroup | null)[] = Array.isArray(mesh.material) && mesh.geometry.groups.length ? mesh.geometry.groups : [null];
    const out: Subset[] = [];
    for (const g of groups) {
      const index = g?.materialIndex ?? 0;
      const m = materials[index];
      if (m?.visible) out.push(this.subset(mesh, m, index, g, data));
    }
    return out;
  }

  // 材質の値 (設計書「MMD が .fx に渡す値」)。MMD の材質は .pmx の値、形はベースカラーとアルファから
  private subset(mesh: THREE.Mesh, m: THREE.Material, index: number, group: THREE.GeometryGroup | null, data: MmdData | null): Subset {
    const lib = this.d.library;
    const md = lib.materials.get(m.userData.materialId);
    const material = md ? baseImage(lib, md) : null;
    const mme = mmeTexturesOf(m);
    const info = data?.materials[index];
    const toon = mme?.toon ? this.toonOf(mme.toon) : null;
    const sphereMode = info?.sphereMode ?? 0;
    const sphere = mme?.sphere && (sphereMode === 1 || sphereMode === 2) ? mme.sphere : null;
    const textures: SubsetTextures = { material, sphere, toon: toon?.tex ?? null };
    const transparent = md ? md.settings.blend === 'blend' : m.transparent;
    const common = {
      groundShadowColor: SHADOW_COLOR, hasTexture: !!material, hasSphere: !!sphere, hasToon: !!mme?.toon, sphereAdd: !!sphere && sphereMode === 2, transparent,
    };
    let state: MaterialState;
    const src = md?.mmd;
    if (src) {
      state = {
        ...common, diffuse: src.diffuse, ambient: src.ambient, specular: src.specular, power: src.shininess,
        toon: toon?.color ?? WHITE, edgeColor: src.edgeColor,
      };
    } else {
      // 形: 拡散色 = ベースカラー (ガンマ空間に直す)、環境色 = その半分、反射なし、輪郭線なし
      const [base, alpha] = this.baseColor(md, m);
      state = {
        ...common, diffuse: [...base, alpha], ambient: base.map(v => v * 0.5) as Color3, specular: [0, 0, 0], power: 5,
        toon: toon?.color ?? WHITE, edgeColor: [0, 0, 0, 1],
      };
    }
    const shapeFlags = (mesh.castShadow ? GROUND_SHADOW | CAST_SELF_SHADOW : 0) | (mesh.receiveShadow ? RECEIVE_SELF_SHADOW : 0);
    const flags = info ? info.flags : shapeFlags;
    const doubleSided = info ? (info.flags & DOUBLE_SIDED) !== 0 : !(md?.settings.backfaceCulling ?? m.side === THREE.FrontSide);
    return { index, group, state, flags, doubleSided, textures };
  }

  // ベースカラー (ガンマ空間) とアルファ。画像がつながっていれば白 (画像の色をそのまま使う)
  private baseColor(md: MaterialData | undefined, m: THREE.Material): [Color3, number] {
    const bsdf = md && surfaceShader(md.tree);
    if (md && bsdf) {
      const linked = !!inputLink(md.tree, bsdf.id, 'baseColor');
      const c = bsdf.values.baseColor as Color3;
      const alpha = inputLink(md.tree, bsdf.id, 'alpha') ? 1 : Number(bsdf.values.alpha ?? 1);
      return [linked ? WHITE : toSrgb(new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace)), alpha];
    }
    const color = (m as THREE.MeshStandardMaterial).color;
    return [color ? toSrgb(color) : WHITE, m.opacity];
  }

  // トゥーンの画像を元の向きにしたテクスチャといちばん下の行の色 (画像ごとに 1 回だけ作る)。読み終えていなければ null
  private toonOf(src: THREE.Texture): Toon | null {
    const img = src.image as { data?: ArrayLike<number>; width?: number; height?: number } | null | undefined;
    if (!img?.data || !img.width || !img.height) return null;
    const old = this.toons.get(src);
    if (old && old.version === src.version) return old;
    old?.tex.dispose();
    const made = unrotateToon({ data: img.data, width: img.width, height: img.height });
    const toon: Toon = { ...made, version: src.version };
    this.toons.set(src, toon);
    return toon;
  }

  // --- 描く ---
  // その MMDPass の technique を選んで (なければ default.fx のもの)、Script のとおりに描く
  private drawPass(table: PassTable, slotEffect: LoadedEffect, item: DrawItem, sub: Subset, pass: MmdPass, frame: FrameState, target: DrawTarget): void {
    const s = sub.state;
    const q: TechniqueQuery = { pass, subset: sub.index, useTexture: s.hasTexture, useSphereMap: s.hasSphere, useToon: s.hasToon, selfShadow: frame.selfShadow };
    let effect = slotEffect;
    let tech = effect.result.ok ? pickTechnique(effect.result.effect, q) : null;
    if (!tech) {
      effect = this.d.defaultEffect;
      tech = effect.result.ok ? pickTechnique(effect.result.effect, q) : null;
    }
    if (!tech) return;
    const inst = this.d.instance(effect);
    if (inst.stopped) return; // (このフレームの途中で止めた。次のフレームから default.fx)
    // 物の technique の Script: Draw=Geometry でいまの材質の部分を描く。描画先を替えたら、終わったあと既定の描画先に戻す
    const fb = this.d.fb();
    const warn = (m: string) => inst.warn(m); // (そのエフェクトの警告)
    const st = new ScriptTargets(fb, effect, inst, warn, target);
    runTechnique(tech, 'object', {
      ...st.commands(),
      drawPass: (p, mode) => {
        if (mode === 'buffer') warn(t('物の .fx の Draw=Buffer にはまだ対応していないので無視します'));
        else if (!inst.stopped) {
          this.drawGeometry(table, inst, effect, p, item, sub, pass, frame, st.current());
          if (st.changed) fb.afterDraw();
        }
      },
      drawExternal: () => {},
      warn,
    });
    if (st.changed) fb.bindSurface(fb.defaultSurface);
  }

  private drawGeometry(
    table: PassTable, inst: EffectInstance, effect: LoadedEffect, p: Pass, item: DrawItem, sub: Subset, pass: MmdPass, frame: FrameState, target: DrawTarget,
  ): void {
    const renderer = this.d.renderer();
    const kind = pass === 'zplot' || pass === 'edge' || pass === 'shadow' ? pass : 'object';
    const base: BaseState = { kind, doubleSided: sub.doubleSided };
    const m = inst.material(p, target.flipY, base);
    if (!m) return;
    const ctx: SemanticContext = {
      camera: frame.camera, light: frame.light, world: item.mesh.matrixWorld, material: sub.state, pass,
      time: frame.time, elapsed: frame.elapsed, screen: frame.screen, selfShadow: frame.selfShadow, owner: table.owner,
      control: ref => this.d.control(ref, item.obj, table.owner),
    };
    const { textures: t } = sub;
    const fb = this.d.fb();
    // (深度マップに描いているあいだは、その深度マップを読ませない)
    const shadow = pass === 'zplot' ? null : this.d.shadowMap();
    const textures: TextureSource = {
      role: name => (name === 'material' ? t.material : name === 'sphere' ? t.sphere : name === 'toon' ? t.toon : name === 'selfShadow' ? shadow
        : fb.colorTexture(effect, name)),
      offscreen: name => this.d.offscreen(effect, name, item.obj),
    };
    inst.bind(m, p, ctx, builtins(target), textures);
    const geometry = pass === 'edge' && item.geo.edge ? item.geo.edge : item.geo.geometry;
    // (scene と group は null でよい: three.js は空の場面・形全体として扱う)
    renderer.renderBufferDirect(this.d.graph.camera, null as unknown as THREE.Scene, geometry, m, this.proxy, sub.group as THREE.GeometryGroup);
    this.checkLink(m, inst, effect);
  }
}
