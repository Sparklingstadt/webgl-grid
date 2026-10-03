import { strFromU8 } from 'fflate';
import { animationFromJson, animationFromPoseKeys, animationToJson, isEmpty } from '../../core/animation';
import { matchAssets } from '../../core/assetMatch';
import { FPS } from '../../core/constants';
import { errorText } from '../../core/errors';
import type { LightSettings } from '../../core/light';
import type { Engine } from '../Engine';
import { applyObjectData } from '../addons/registry';
import { download } from '../io/download';
import { isModel, kindOf, type Any, type ModelObj, type Obj } from '../types';
import {
  MOVED_TO_ADDONS, PROJECT_EXT, PROJECT_FORMAT, PROJECT_VERSION, ProjectCancelled, parseData, projectBaseName, readEmbedded, writeEmbedded, writeReference,
  type PickMissing, type ProjectData, type ProjectStorage, type SavedAsset, type SavedImage, type SavedMaterial, type SavedObject,
} from './format';

export { PROJECT_EXT, ProjectCancelled, projectBaseName, type ProjectData, type ProjectStorage } from './format';

// --- プロジェクト: 場面とプロジェクトのデータ (format.ts) の行き来と、保存・開く画面の操作 ---
export class ProjectIO {
  // このページで読み込んだファイル (名前と大きさ → File)。参照だけのプロジェクトを開くとき、まずここから探す
  private known = new Map<string, File>();

  constructor(private engine: Engine) {}

  // --- 画面の操作 ---
  // 保存してダウンロードさせる。embedded: ファイルも入れた .wgp、reference: ファイルは参照だけの .wgpj
  async saveFile(storage: ProjectStorage = 'embedded') {
    const { ui } = this.engine;
    ui.toast('プロジェクトを保存中…', 0);
    try {
      const bytes = await this.save(storage);
      const name = `${ui.state.projectName ?? 'プロジェクト'}.${PROJECT_EXT[storage]}`;
      download(bytes, name, storage === 'reference' ? 'application/json' : 'application/zip');
      ui.set({ projectName: projectBaseName(name) });
      ui.toast(`${name} を保存しました (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      console.error(err);
      ui.toast(`プロジェクトを保存できませんでした: ${errorText(err)}`, 8000);
    }
  }
  // 選ばれたファイルを開く。参照しているファイルが見つからなければ、画面で探してもらう
  async openFile(file: File) {
    const { ui } = this.engine;
    ui.toast(`${file.name} を開いています…`, 0);
    let skipped = 0;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { missingAddons } = await this.engine.history.batch(() => this.open(bytes, {
        pick: async missing => {
          ui.hideToast();
          const r = await this.askMissing(file.name, missing);
          if (r === 'skip') skipped = missing.length;
          ui.toast(`${file.name} を開いています…`, 0);
          return r;
        },
      }));
      ui.set({ projectName: projectBaseName(file.name) });
      const notes = [
        ...(skipped ? [`見つからないファイルが ${skipped} 個あります`] : []),
        ...(missingAddons.length ? [`アドオン ${missingAddons.join('・')} のデータがあります。有効にしてから開き直すと戻ります`] : []),
      ];
      ui.toast(notes.length ? `${file.name} を開きました (${notes.join('。')})` : `${file.name} を開きました`, notes.length ? 8000 : 4000);
    } catch (err) {
      if (err instanceof ProjectCancelled) { ui.toast('プロジェクトを開くのをやめました'); return; }
      console.error(err);
      ui.toast(`${file.name} を開けませんでした: ${errorText(err)}`, 8000);
    }
  }
  // 見つからないファイルの画面: 選んだファイル (フォルダ) を渡す・見つかったものだけで開く・やめる
  private missingAnswer: ((r: File[] | 'skip' | 'cancel') => void) | null = null;
  private askMissing(project: string, missing: SavedAsset[]) {
    this.engine.ui.set({ missingFiles: { project, files: missing.map(({ name, size, source }) => ({ name, size, source })) } });
    return new Promise<File[] | 'skip' | 'cancel'>(ok => { this.missingAnswer = ok; });
  }
  answerMissing(r: File[] | 'skip' | 'cancel') {
    const answer = this.missingAnswer;
    this.missingAnswer = null;
    this.engine.ui.set({ missingFiles: null });
    answer?.(r);
  }

  // --- データ ---
  remember(files: File[]) {
    for (const f of files) this.known.set(`${f.name.normalize('NFC')}\0${f.size}`, f);
  }

  // いまの場面を .wgp (ZIP) か .wgpj (JSON) のバイト列にする
  async save(storage: ProjectStorage = 'embedded'): Promise<Uint8Array> {
    const { data, assets } = this.build(storage);
    return storage === 'reference' ? writeReference(data) : writeEmbedded(data, assets);
  }
  // 参照だけの形 (.wgpj の JSON) と、参照しているファイル (asset の id → File)。自動保存で使う
  saveReference(): { bytes: Uint8Array; files: Map<string, File> } {
    const { data, assets } = this.build('reference');
    return { bytes: writeReference(data), files: new Map([...assets].map(([f, a]) => [a.id, f])) };
  }
  // いまの場面をプロジェクトのデータにする (読み込んだファイルは asset として並べる)
  private build(storage: ProjectStorage): { data: ProjectData; assets: Map<File, SavedAsset> } {
    const e = this.engine, lib = e.library;
    const assets = new Map<File, SavedAsset>();
    const asset = (f: File) => {
      let a = assets.get(f);
      if (!a) {
        const id = `a${assets.size + 1}`;
        const source: string | undefined = (f as Any).sourcePath;
        a = { id, name: f.name, type: f.type, size: f.size, ...(storage === 'embedded' ? { path: `assets/${id}/${f.name}` } : {}), ...(source ? { source } : {}) };
        assets.set(f, a);
      }
      return a.id;
    };
    const filesOf = (mesh: Any): string[] => [...(mesh.userData.usedFiles ?? [mesh.userData.sourceFile])].map(asset);
    const objects: SavedObject[] = e.world.objects.map(o => {
      const base: SavedObject = { kind: kindOf(o), s: o.s, x: o.x, y: o.y, z: o.z, r: o.r, c: o.c, slots: [...o.slots], activeSlot: o.activeSlot };
      // 物ごとの値 (ライト・アドオンのもの)。アドオンの値は、ある物だけ
      for (const d of e.addons.objectData.list()) { const v = d.get(o) ?? null; if (v !== null || !d.key.includes('.')) base[d.key] = v; }
      if (!isModel(o)) return base;
      const inf: number[] | undefined = o.model.morphTargetInfluences;
      return {
        ...base,
        files: filesOf(o.model),
        pose: [...(o.pose ?? [])],
        morphs: inf ? Array.from(inf) : null,
        anim: isEmpty(o.anim) ? null : animationToJson(o.anim!),
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
        const k = isModel(o) ? (o.model.userData.convertedImages ?? []).indexOf(img.id) : -1;
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
      format: PROJECT_FORMAT, version: PROJECT_VERSION, storage,
      assets: [], objects,
      stage: e.stage.model ? { files: filesOf(e.stage.model) } : null,
      materials, images,
      camera: { ...e.camera.cam, mode: e.camera.mode, viewName: e.camera.viewName },
      cameraMotion: e.motion.camera && e.motion.cameraFile ? asset(e.motion.cameraFile) : null,
      music: e.music.file ? asset(e.music.file) : null,
      timeline: { start: e.clock.start, end: e.clock.end, frame: e.clock.frame },
      selected: cur ? e.world.objects.indexOf(cur) : null,
    };
    for (const d of e.addons.sceneData.list()) data[d.key] = structuredClone(d.save()); // 場面の値 (シーン・出力・アドオンのもの)
    data.assets = [...assets.values()];
    return { data, assets };
  }

  // .wgpj: 参照しているファイルを、渡されたもの → このページで読んだもの → 選んでもらったもの、の順に探す
  private async readReference(bytes: Uint8Array, opts: { provided?: Map<string, File>; pick?: PickMissing }) {
    const data = parseData(strFromU8(bytes));
    const files = new Map<string, File>();
    for (const a of data.assets) {
      const f = opts.provided?.get(a.id) ?? this.known.get(`${a.name.normalize('NFC')}\0${a.size}`);
      if (f) files.set(a.id, f);
    }
    for (;;) {
      const missing = data.assets.filter(a => !files.has(a.id));
      if (!missing.length || !opts.pick) break;
      const picked = await opts.pick(missing);
      if (picked === 'cancel') throw new ProjectCancelled();
      if (picked === 'skip') break;
      for (const [id, f] of matchAssets(missing, picked)) files.set(id, f);
    }
    return { data, files };
  }

  // .wgp / .wgpj を開いて、場面をそのとおりに作り直す。
  // provided: 参照しているファイル (asset の id → File。MCP サーバーが探して送ったもの)。pick: 見つからないファイルを探してもらう
  async open(bytes: Uint8Array, opts: { provided?: Map<string, File>; pick?: PickMissing } = {}) {
    const e = this.engine, lib = e.library;
    const { data, files } = bytes[0] === 0x7b /* { */ ? await this.readReference(bytes, opts) : await readEmbedded(bytes);
    this.remember([...files.values()]);
    const fileOf = (id: string | null | undefined) => (id ? files.get(id) ?? null : null);
    const filesOf = (ids: string[] | undefined) => (ids ?? []).map(fileOf).filter((f): f is File => !!f);

    // まっさらにする
    e.resetAll();
    e.world.clear();
    lib.reset();

    // ステージと物 (保存した順。積み重ねの高さも戻す)
    if (data.stage) {
      const loaded = await e.loader.load(filesOf(data.stage.files));
      if (loaded) e.stage.set(loaded.mesh);
    }
    const objs: (Obj | null)[] = [];
    for (const so of data.objects) {
      let obj: Obj | null = null;
      if (so.kind === 'light') {
        obj = e.lights.add((so.light ?? {}) as Partial<LightSettings>, so.x, so.z);
      } else if (so.kind === 'shape') {
        obj = e.world.addShape(so.s, so.x, so.z, so.c);
      } else {
        const loaded = await e.loader.load(filesOf(so.files));
        if (loaded) obj = e.world.addModel(loaded.mesh, so.x, so.z, loaded.slots);
      }
      if (obj) Object.assign(obj, { x: so.x, z: so.z, r: so.r, y: so.y, py: so.y, vy: 0, activeSlot: so.activeSlot });
      objs.push(obj);
    }
    for (const obj of objs) if (isModel(obj)) await e.physics.start(obj);

    // 画像を対応づけ、保存したマテリアルを作ってスロットに入れる
    const imageId = new Map<string, string>();
    for (const img of data.images) {
      const f = img.from;
      if ('asset' in f) {
        const file = fileOf(f.asset);
        if (file) imageId.set(img.id, await e.materials.openImage(file, f.flipY));
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
      if (!obj) return;
      so.slots.forEach((id, k) => e.world.setSlot(obj, k, id ? matId.get(id) ?? null : null));
      for (const d of e.addons.objectData.list()) applyObjectData(d, obj, so[d.key] ?? d.aliases?.map(a => so[a]).find(v => v != null)); // 物ごとの値 (前の版の名前でも)
    });
    // 作り直すときに変換したマテリアル (もう使っていない) を片付けてから、保存した名前に戻す
    for (const id of [...lib.materials.keys()]) if (![...matId.values()].includes(id)) lib.remove(id);
    for (const m of data.materials) lib.rename(matId.get(m.id)!, m.name);

    // ポーズ・表情・キーフレーム・髪
    data.objects.forEach((so, i) => {
      const obj = objs[i];
      if (!isModel(obj) || !so.pose) return;
      const m = obj;
      m.pose = new Map(so.pose);
      const inf: number[] | undefined = m.model.morphTargetInfluences;
      if (inf && so.morphs) so.morphs.forEach((v, k) => { inf[k] = v; });
      m.anim = so.anim ? animationFromJson(so.anim) : so.keys?.length ? animationFromPoseKeys(so.keys) : null; // (版 1 は変換する)
      m.boneSel = so.boneSel;
      if (so.hairHang) e.physics.setHairHang(m, true);
      e.posing.solve(m);
    });

    // モーション (同じ .vmd を付けたモデルはまとめて)・カメラモーション・曲
    const byMotion = new Map<string, ModelObj[]>();
    data.objects.forEach((so, i) => {
      const obj = objs[i];
      if (isModel(obj) && so.motion) byMotion.set(so.motion, [...(byMotion.get(so.motion) ?? []), obj]);
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
    for (const d of e.addons.sceneData.list()) d.load(data[d.key] as never);
    e.history.reset(); // 開いた状態から、元に戻す履歴を始める
    e.select(data.selected !== null ? objs[data.selected] ?? null : null);
    e.world.settle();
    e.viewport.requestDraw();
    // 有効でないアドオンのデータ (名前が "アドオンの id.名前" で登録されていないものと、アドオンに移した前の版の値)
    const missing = new Set<string>();
    const look = (o: Record<string, unknown>, known: (k: string) => boolean) => {
      for (const [k, v] of Object.entries(o)) {
        if (k.includes('.') && v !== null && v !== undefined && !known(k)) missing.add(k.split('.')[0]);
        else if (k in MOVED_TO_ADDONS && v !== null && !known(k)) missing.add(MOVED_TO_ADDONS[k]);
      }
    };
    const objectKeys = new Set(e.addons.objectData.list().flatMap(d => [d.key, ...d.aliases ?? []]));
    look(data, k => e.addons.sceneData.has(k));
    for (const so of data.objects) look(so, k => objectKeys.has(k));
    return { missingAddons: [...missing] };
  }
}
