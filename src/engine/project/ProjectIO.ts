import { strFromU8, strToU8, unzip, zip, type AsyncZippable } from 'fflate';
import { FPS } from '../../core/constants';
import { normalizeOutput, type OutputSettings } from '../../core/output';
import type { NodeTree } from '../../core/materials/tree';
import type { BoneValue } from '../../core/types';
import type { Engine } from '../Engine';
import { convertMmdMesh } from '../materials/fromMmd';
import type { MaterialOutline, MaterialSettings, MmdSource } from '../materials/MaterialLibrary';
import type { Any, ModelObj, Obj } from '../types';

// --- プロジェクト (.wgp) の保存と読み込み ---
// ZIP の中に project.json (場面の状態) と、読み込んだファイルそのもの (assets/) を入れる。
// ファイルが入っているので、保存したプロジェクトだけで同じ場面を開き直せる
export const PROJECT_FORMAT = 'webgl-grid-project';
export const PROJECT_VERSION = 1;

type Pose = [number, BoneValue][];
interface SavedAsset { id: string; name: string; type: string; path: string }
interface SavedObject {
  kind: 'shape' | 'model';
  s: number; x: number; y: number; z: number; r: number; c: number;
  slots: (string | null)[];
  activeSlot?: number;
  // MMD モデルだけ
  files?: string[];
  pose?: Pose;
  morphs?: number[] | null;
  keys?: [number, { pose: Pose; morphs: number[] | null }][];
  hairHang?: boolean;
  motion?: string | null;
  boneSel?: number;
}
interface SavedImage {
  id: string;
  name: string;
  from: { object: number | 'stage'; index: number } | { asset: string; flipY: boolean };
}
interface SavedMaterial { id: string; name: string; tree: NodeTree; settings: MaterialSettings; outline: MaterialOutline; mmd?: MmdSource }
export interface ProjectData {
  format: typeof PROJECT_FORMAT;
  version: number;
  assets: SavedAsset[];
  objects: SavedObject[];
  stage: { files: string[] } | null;
  materials: SavedMaterial[];
  images: SavedImage[];
  camera: { yaw: number; pitch: number; dist: number; tx: number; ty: number; tz: number; fov: number; mode: 'orbit' | 'pan'; viewName: string };
  cameraMotion: string | null;
  music: string | null;
  timeline: { start: number; end: number; frame: number };
  selected: number | null;
  output?: OutputSettings; // 出力 (レンダリングの大きさ・形式)。古いプロジェクトにはない
}

const zipAsync = (files: AsyncZippable) => new Promise<Uint8Array>((ok, ng) => zip(files, { level: 6 }, (err, data) => (err ? ng(err) : ok(data))));
const unzipAsync = (data: Uint8Array) => new Promise<Record<string, Uint8Array>>((ok, ng) => unzip(data, (err, files) => (err ? ng(err) : ok(files))));
// 画像・曲はもう圧縮されているので、縮めずにそのまま入れる (速い)
const STORED = /\.(png|jpe?g|gif|webp|mp3|m4a|aac|ogg|oga|opus|flac)$/i;

export class ProjectIO {
  constructor(private engine: Engine) {}

  // いまの場面を .wgp のバイト列にする
  async save(): Promise<Uint8Array> {
    const e = this.engine, lib = e.library;
    const assets = new Map<File, SavedAsset>();
    const asset = (f: File) => {
      let a = assets.get(f);
      if (!a) {
        const id = `a${assets.size + 1}`;
        a = { id, name: f.name, type: f.type, path: `assets/${id}/${f.name}` };
        assets.set(f, a);
      }
      return a.id;
    };
    const filesOf = (mesh: Any): string[] => [...(mesh.userData.usedFiles ?? [mesh.userData.sourceFile])].map(asset);
    const objects: SavedObject[] = e.world.objects.map(o => {
      const base: SavedObject = { kind: o.s === 3 ? 'model' : 'shape', s: o.s, x: o.x, y: o.y, z: o.z, r: o.r, c: o.c, slots: [...o.slots], activeSlot: o.activeSlot };
      if (o.s !== 3) return base;
      const inf: number[] | undefined = o.model.morphTargetInfluences;
      return {
        ...base,
        files: filesOf(o.model),
        pose: [...(o.pose ?? [])],
        morphs: inf ? Array.from(inf) : null,
        keys: [...(o.keys ?? [])].map(([f, k]) => [f, { pose: [...k.pose], morphs: k.morphs ? Array.from(k.morphs) : null }]),
        hairHang: e.physics.hairHang(o) ?? false,
        motion: o.motionFile ? asset(o.motionFile) : null,
        boneSel: o.boneSel,
      };
    });
    // 画像: MMD のテクスチャは「どの物 (かステージ) の何番目」、開いた画像はファイル
    const images: SavedImage[] = [];
    for (const img of lib.images.values()) {
      let from: SavedImage['from'] | null = null;
      e.world.objects.forEach((o, i) => {
        const k = o.s === 3 ? (o.model.userData.convertedImages ?? []).indexOf(img.id) : -1;
        if (k >= 0 && !from) from = { object: i, index: k };
      });
      const k = e.stage.model ? (e.stage.model.userData.convertedImages ?? []).indexOf(img.id) : -1;
      if (!from && k >= 0) from = { object: 'stage', index: k };
      if (!from && img.file) from = { asset: asset(img.file), flipY: img.texture.flipY };
      if (from) images.push({ id: img.id, name: img.name, from });
    }
    // マテリアル: 使っている物があるものだけ (Blender と同じく、使っていないものは保存しない)
    const materials: SavedMaterial[] = [...lib.materials.values()].filter(m => lib.users(m.id) > 0)
      .map(m => ({ id: m.id, name: m.name, tree: m.tree, settings: m.settings, outline: m.outline, mmd: m.mmd }));
    const cur = e.selection.current;
    const data: ProjectData = {
      format: PROJECT_FORMAT, version: PROJECT_VERSION,
      assets: [], objects,
      stage: e.stage.model ? { files: filesOf(e.stage.model) } : null,
      materials, images,
      camera: { ...e.camera.cam, mode: e.camera.mode, viewName: e.camera.viewName },
      cameraMotion: e.motion.camera && e.motion.cameraFile ? asset(e.motion.cameraFile) : null,
      music: e.music.file ? asset(e.music.file) : null,
      timeline: { start: e.clock.start, end: e.clock.end, frame: e.clock.frame },
      selected: cur ? e.world.objects.indexOf(cur) : null,
      output: { ...e.output.settings },
    };
    data.assets = [...assets.values()];
    const files: AsyncZippable = { 'project.json': strToU8(JSON.stringify(data, null, 1)) };
    for (const [f, a] of assets) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      files[a.path] = STORED.test(f.name) ? [bytes, { level: 0 }] : bytes;
    }
    return zipAsync(files);
  }

  // .wgp を開いて、場面をそのとおりに作り直す
  async open(bytes: Uint8Array) {
    const e = this.engine, lib = e.library;
    let entries: Record<string, Uint8Array>;
    try { entries = await unzipAsync(bytes); } catch { throw new Error('プロジェクトのファイル (.wgp) ではありません'); }
    const json = entries['project.json'];
    if (!json) throw new Error('プロジェクトのファイル (.wgp) ではありません (project.json がありません)');
    const data = JSON.parse(strFromU8(json)) as ProjectData;
    if (data.format !== PROJECT_FORMAT) throw new Error('プロジェクトのファイル (.wgp) ではありません');
    if (data.version > PROJECT_VERSION) throw new Error('このプロジェクトは新しい版で保存されています');
    const files = new Map<string, File>();
    for (const a of data.assets) {
      const body = entries[a.path];
      if (body) files.set(a.id, new File([body as BlobPart], a.name, { type: a.type }));
    }
    const fileOf = (id: string | null | undefined) => (id ? files.get(id) ?? null : null);

    // まっさらにする
    e.resetAll();
    e.world.clear();
    lib.reset();

    // ステージと物 (保存した順。積み重ねの高さも戻す)
    if (data.stage) {
      const mesh = await e.loader.loadPmx(data.stage.files.map(fileOf).filter((f): f is File => !!f));
      if (mesh) { convertMmdMesh(mesh, lib); e.stage.set(mesh); }
    }
    const objs: (Obj | null)[] = [];
    for (const so of data.objects) {
      let obj: Obj | null = null;
      if (so.kind === 'shape') {
        obj = e.world.addShape(so.s, so.x, so.z, so.c);
      } else {
        const mesh = await e.loader.loadPmx((so.files ?? []).map(fileOf).filter((f): f is File => !!f));
        if (mesh) {
          const slots = convertMmdMesh(mesh, lib);
          obj = e.world.addModel(mesh, so.x, so.z, slots);
        }
      }
      if (obj) Object.assign(obj, { x: so.x, z: so.z, r: so.r, y: so.y, py: so.y, vy: 0, activeSlot: so.activeSlot });
      objs.push(obj);
    }
    for (const obj of objs) if (obj?.s === 3) await e.physics.start(obj as ModelObj);

    // 画像を対応づけ、保存したマテリアルを作ってスロットに入れる
    const imageId = new Map<string, string>();
    for (const img of data.images) {
      const f = img.from;
      if ('asset' in f) {
        const file = fileOf(f.asset);
        if (file) imageId.set(img.id, await e.openImage(file, f.flipY));
      } else {
        const holder = f.object === 'stage' ? e.stage.model : (objs[f.object] as ModelObj | null)?.model;
        const id = holder?.userData.convertedImages?.[f.index];
        if (id) imageId.set(img.id, id);
      }
    }
    const matId = new Map<string, string>();
    for (const m of data.materials) {
      const tree = structuredClone(m.tree);
      for (const n of tree.nodes) if (n.props.image) n.props.image = imageId.get(n.props.image) ?? '';
      matId.set(m.id, lib.create(`${m.name} (読み込み中)`, { tree, settings: { ...m.settings }, outline: { ...m.outline }, mmd: m.mmd }).id);
    }
    data.objects.forEach((so, i) => {
      const obj = objs[i];
      if (obj) so.slots.forEach((id, k) => e.world.setSlot(obj, k, id ? matId.get(id) ?? null : null));
    });
    // 作り直すときに変換したマテリアル (もう使っていない) を片付けてから、保存した名前に戻す
    for (const id of [...lib.materials.keys()]) if (![...matId.values()].includes(id)) lib.remove(id);
    for (const m of data.materials) lib.rename(matId.get(m.id)!, m.name);

    // ポーズ・表情・キーフレーム・髪
    data.objects.forEach((so, i) => {
      const obj = objs[i];
      if (obj?.s !== 3 || !so.pose) return;
      const m = obj as ModelObj;
      m.pose = new Map(so.pose);
      const inf: number[] | undefined = m.model.morphTargetInfluences;
      if (inf && so.morphs) so.morphs.forEach((v, k) => { inf[k] = v; });
      m.keys = so.keys?.length ? new Map(so.keys.map(([f, k]) => [f, { pose: new Map(k.pose), morphs: k.morphs ? Float32Array.from(k.morphs) : null }])) : null;
      m.boneSel = so.boneSel;
      if (so.hairHang) e.physics.setHairHang(m, true);
      e.posing.solve(m);
    });

    // モーション (同じ .vmd を付けたモデルはまとめて)・カメラモーション・曲
    const byMotion = new Map<string, ModelObj[]>();
    data.objects.forEach((so, i) => {
      const obj = objs[i];
      if (obj?.s === 3 && so.motion) byMotion.set(so.motion, [...(byMotion.get(so.motion) ?? []), obj as ModelObj]);
    });
    for (const [id, targets] of byMotion) { const f = fileOf(id); if (f) await e.motion.load([f], targets); }
    const camFile = fileOf(data.cameraMotion);
    if (camFile) await e.motion.load([camFile], []);
    const song = fileOf(data.music);
    if (song) e.music.load(song);

    // 視点・タイムライン・選択
    const { mode, viewName, ...cam } = data.camera;
    Object.assign(e.camera.cam, cam);
    e.camera.setMode(mode);
    e.camera.viewName = viewName;
    e.clock.setRange(data.timeline.start, data.timeline.end);
    e.clock.setPlaying(false);
    e.clock.seek(data.timeline.frame / FPS);
    e.output.set(normalizeOutput(data.output));
    e.select(data.selected !== null ? objs[data.selected] ?? null : null);
    e.world.settle();
    e.viewport.requestDraw();
  }
}
