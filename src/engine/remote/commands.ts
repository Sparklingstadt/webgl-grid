import { FPS, PALETTE_NAMES, VIEWPORT_BG } from '../../core/constants';
import { SHADING_MODES, type ShadingMode } from '../render/Viewport';
import { SHAPES, findShape } from '../../core/shapes';
import { hexToLinear, linearToHex } from '../../core/materials/color';
import { NODE_TYPES } from '../../core/materials/nodes';
import { surfaceShader } from '../../core/materials/tree';
import { regionPixels, type OutputSettings } from '../../core/output';
import { fromBase64, toBase64, type RemoteFile } from '../../core/remote';
import { keyFrames } from '../../core/animation';
import type { BoneValue } from '../../core/types';
import { errorText } from '../../core/errors';
import { t } from '../../core/i18n';
import { ACCESSORY_DEFAULTS, ACCESSORY_ITEMS, isAccessoryItem } from '../../core/mme/accessory';
import { paramChannels } from '../../core/mme/params';
import { normalizeMme, type MmeSettings, type ObjectEffects, type SavedSlot } from '../../core/mme/settings';
import { mmeChannel } from '../anim/mmeChannels';
import type { Engine } from '../Engine';
import { fetchFxFiles, listFxFolder } from '../io/fxFolder';
import { findFile } from '../mme/EffectStore';
import { STAGE_ROW_ID } from '../UiChannel';
import { nameOf } from '../world/Selection';
import { projectBaseName } from '../project/ProjectIO';
import type { FxKey, FxLevel } from '../render/postfx';
import { canScale, isModel, kindOf, type Any, type ModelObj, type Obj } from '../types';

// --- 外部 (MCP) から使える操作 ---
// 名前 → (エンジン, 引数) → 結果 (JSON にできる値)。ファイルは base64 でやりとりする。
// 画面の操作と同じ Engine の操作を呼ぶので、画面にもそのまま反映される
export type Command = (e: Engine, p: Any) => unknown;

const DEG = 180 / Math.PI;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function objOf(e: Engine, id: unknown): Obj {
  const obj = id === undefined || id === null ? e.selection.current : e.world.find(Number(id));
  if (!obj) throw new Error(id === undefined || id === null ? t('物を選んでいません。id を指定してください') : t('id {id} の物はありません', { id: String(id) }));
  return obj;
}
function modelOf(e: Engine, id: unknown): ModelObj {
  const obj = id === undefined || id === null ? e.selection.model ?? e.world.models[0] : objOf(e, id);
  if (!isModel(obj)) throw new Error('MMD モデルではありません (先に load_files で .pmx を読み込んでください)');
  return obj;
}
function shapeIndex(shape: unknown) {
  const s = findShape(shape);
  if (s === null) throw new Error(`形は ${SHAPES.map(d => d.key).join(' / ')} のどれかです`);
  return s;
}
function colorIndex(color: unknown) {
  const i = typeof color === 'number' ? color : PALETTE_NAMES.indexOf(String(color));
  if (!(i >= 0 && i < PALETTE_NAMES.length)) throw new Error(`色は 0〜7 か ${PALETTE_NAMES.join('・')} です`);
  return i;
}
function boneIndex(obj: ModelObj, bone: unknown) {
  const bones: { name: string }[] = obj.model.skeleton.bones;
  const i = typeof bone === 'number' ? bone : bones.findIndex(b => b.name === bone);
  if (!(i >= 0 && i < bones.length)) throw new Error(`ボーン ${bone} はありません (list_bones で名前を確かめてください)`);
  return i;
}

// 場面の様子
export function sceneState(e: Engine) {
  const lib = e.library, cam = e.camera.cam;
  return {
    project: e.ui.state.projectName,
    timeline: { frame: e.clock.frame, start: e.clock.start, end: e.clock.end, playing: e.clock.playing, fps: FPS },
    selected: e.selection.current?.id ?? null,
    selectedIds: e.selection.list.map(o => o.id),
    objects: e.world.objects.map(o => ({
      id: o.id,
      kind: kindOf(o),
      name: nameOf(o),
      ...(o.hidden ? { hidden: true } : {}),
      ...(o.hideRender ? { hideRender: true } : {}),
      ...(o.light ? { light: o.light } : {}),
      ...(o.camera ? { camera: o.camera, sceneCamera: o === e.cameras.scene } : {}),
      position: [r3(o.x), r3(o.y), r3(o.z)],
      rotationDeg: r3(o.r * DEG),
      ...(o.scale ? { scale: r3(o.scale) } : {}),
      ...(o.parent !== undefined ? { parent: o.parent } : {}),
      ...(o.collection ? { collection: o.collection } : {}),
      ...(isModel(o)
        ? { motion: o.motionFiles?.map(f => f.name).join(', ') || null, keyframes: keyFrames(o.anim), hairHang: e.physics.hairHang(o) }
        : { color: PALETTE_NAMES[o.c] }),
      materials: o.slots.map(id => (id ? lib.materials.get(id)?.name ?? null : null)),
      ...(o.addonData && Object.keys(o.addonData).length ? { addons: o.addonData } : {}), // アドオンの、物ごとの値
    })),
    stage: e.stage.model?.name ?? null,
    music: e.music.file?.name ?? null,
    cameraMotion: e.motion.camera ? e.motion.cameraFile?.name ?? '(あり)' : null,
    camera: { yawDeg: r3(cam.yaw * DEG), pitchDeg: r3(cam.pitch * DEG), distance: r3(cam.dist), target: [r3(cam.tx), r3(cam.ty), r3(cam.tz)], fov: cam.fov, view: e.camera.viewName || null, shading: e.shading.mode },
    effects: { enabled: e.ui.state.fxState, levels: e.ui.state.fxLevel },
    output: e.output.settings,
    scene: e.environment.settings,
    // アドオンの場面の値 (名前は "アドオンの id.名前")
    addons: Object.fromEntries(e.addons.sceneData.list().filter(p => p.key.includes('.')).map(p => [p.key, p.save()])),
  };
}

// 描画先があれば、いまのビューポートの絵 (編集用の表示も込み) を PNG にする。長い辺は maxSize まで縮める
function screenshot(e: Engine, maxSize: number) {
  const { viewport } = e;
  if (!viewport.mounted || !viewport.canvas) throw new Error('描画先がありません (ページを開いてください)');
  viewport.render();
  const src = viewport.canvas;
  const k = Math.min(1, maxSize / Math.max(src.width, src.height));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(src.width * k), height: Math.round(src.height * k) });
  const g = c.getContext('2d')!;
  g.fillStyle = VIEWPORT_BG; // 背景は CSS の色 (canvas は透明) なので塗っておく
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, 0, 0, c.width, c.height);
  return { png: c.toDataURL('image/png').slice('data:image/png;base64,'.length), width: c.width, height: c.height };
}

// --- MME 互換 (割り当て・アクセサリ・コントローラー・パラメータ・.emm) ---
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const listOf = (names: string[]) => names.join('・') || t('なし');

// 画面に知らせる MME の状態 (割り当ての行・タブ・フォルダ・ポストエフェクトなど)。物の変化に追いつくよう、先に作り直させる
function mmeUi(e: Engine) {
  e.mme.publish();
  return e.ui.state.mme;
}

// 割り当てる相手: 物の id (省くと選んでいる物) か 'stage' (ステージ。ないときはエラー)
function mmeTarget(e: Engine, id: unknown): Obj | 'stage' {
  if (id !== 'stage') return objOf(e, id);
  if (!mmeUi(e).rows.Main?.some(r => r.objId === STAGE_ROW_ID)) throw new Error(t('ステージがありません'));
  return 'stage';
}

// 割り当ての fx の書き方 (フォルダの名前も添える)
function slotJson(e: Engine, slot: SavedSlot) {
  return slot === 'hide' ? 'hide' : { folder: slot.folder, folderName: e.mme.store.folder(slot.folder)?.name ?? null, path: slot.path };
}

// 渡された fx ({ folder, path }。folder は読み込んだフォルダの名前か id、path は大文字小文字を問わない) を、割り当てにする
function fxSlot(e: Engine, fx: unknown): SavedSlot {
  const { folder, path } = isRecord(fx) ? fx : {};
  if (typeof folder !== 'string' || typeof path !== 'string' || !folder || !path) throw new Error(t('fx は { folder, path } か "hide" か null です'));
  const folders = e.mme.store.folders();
  const found = folders.find(f => f.id === folder) ?? folders.find(f => f.name === folder) ?? folders.find(f => f.name.toLowerCase() === folder.toLowerCase());
  if (!found) throw new Error(t('フォルダ {folder} は読み込んでいません ({list})', { folder, list: listOf(folders.map(f => f.name)) }));
  const file = findFile(found, path);
  if (!file || !/\.fx$/i.test(file)) throw new Error(t('フォルダ {folder} に .fx {path} はありません', { folder: found.name, path }));
  return { folder: found.id, path: file };
}

// 全部の割り当て (ステージ・物。物全体は material が null)
function mmeAssignments(e: Engine) {
  const out: { object: number | 'stage'; tab: string; material: number | null; fx: ReturnType<typeof slotJson> }[] = [];
  const add = (object: number | 'stage', all: ObjectEffects | null | undefined) => {
    for (const [tab, effects] of Object.entries(all ?? {})) {
      if (effects.object) out.push({ object, tab, material: null, fx: slotJson(e, effects.object) });
      for (const [m, slot] of Object.entries(effects.materials ?? {})) out.push({ object, tab, material: Number(m), fx: slotJson(e, slot) });
    }
  };
  add('stage', e.mme.saveScene().stage);
  for (const o of e.world.objects) add(o.id, o.mme);
  return out;
}

// 物 (ステージ) に当てた .fx のパラメータ (チャンネルの名前つき)
function mmeParams(e: Engine, target: Obj | 'stage') {
  return e.mme.paramsOf(target).flatMap(({ effect, params }) => params.map(p => ({ effect, p, channels: paramChannels(effect.folder, effect.path, p) })));
}

// 物 (ステージ) の MME の値の名前と、いまの値 (なければ MME の既定。コントローラーの項目は 0)。コントローラーの項目は、描いている
// エフェクトが読む名前と物のチャンネル、アクセサリは X〜Tr、どれにも当てた .fx のパラメータの成分
function mmeValueTable(e: Engine, target: Obj): Map<string, number> {
  const own = target.mmeValues ?? {};
  const out = new Map<string, number>();
  if (target.mmeObj?.kind === 'accessory') for (const name of ACCESSORY_ITEMS) out.set(name, own[name] ?? ACCESSORY_DEFAULTS[name]);
  if (target.mmeObj?.kind === 'controller') {
    for (const c of mmeUi(e).controllers) if (c.objId === target.id) for (const item of c.items) out.set(item, own[item] ?? 0);
    for (const name of target.mmeChannels ?? []) out.set(name, own[name] ?? 0);
  }
  for (const { p, channels } of mmeParams(e, target)) channels.forEach((ch, i) => out.set(ch, p.value[i]));
  return out;
}

const finiteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const unknownValue = (name: string) => new Error(t('値 {name} はありません (mme_state で名前を確かめてください)', { name }));
const notNumber = (name: string) => new Error(t('値 {name} は数です', { name }));

// mme_set_values: 名前 → 値 (数。ベクトルのパラメータは成分の配列もよい) を、壊れたものが 1 つでもあれば何も変えずに、物に書く。
// 書いた (範囲に収めた) 値を、チャンネルの名前 (ベクトルのパラメータは成分ごと) で返す
function setMmeValues(e: Engine, target: Obj | 'stage', values: unknown) {
  if (!isRecord(values) || Object.keys(values).length === 0) throw new Error(t('values に値を渡してください'));
  const kind = target === 'stage' ? null : target.mmeObj?.kind;
  const params = mmeParams(e, target);
  const items = new Map<string, number>();
  // パラメータは、組 (.fx のパスと名前) ごとに、成分の値を重ねる (まとめて・成分ごとを混ぜてもよい)
  const writes = new Map<string, { effect: { folder: string; path: string }; name: string; channels: string[]; value: number[] }>();
  for (const [name, raw] of Object.entries(values)) {
    if (kind === 'controller' || (kind === 'accessory' && isAccessoryItem(name))) {
      if (!finiteNumber(raw)) throw notNumber(name);
      items.set(name, raw);
      continue;
    }
    const found = params.find(x => x.channels.includes(name) || name === `${x.effect.folder}/${x.effect.path}:${x.p.name}`);
    if (!found) throw unknownValue(name);
    const base = `${found.effect.folder}/${found.effect.path}:${found.p.name}`;
    const list = Array.isArray(raw) ? raw : [raw];
    if (!list.every(finiteNumber)) throw notNumber(name);
    const w = writes.get(base) ?? { effect: found.effect, name: found.p.name, channels: found.channels, value: [...found.p.value] };
    writes.set(base, w);
    const at = name === base ? 0 : found.channels.indexOf(name);
    if (at + list.length > w.channels.length) throw new Error(t('値 {name} は成分が {n} 個までです', { name, n: w.channels.length }));
    list.forEach((v, i) => { w.value[at + i] = v; });
  }
  const result: Record<string, number> = {};
  if (target !== 'stage') for (const [name, v] of items) { e.mme.setItem(target, name, v); result[name] = target.mmeValues?.[name] ?? v; }
  for (const w of writes.values()) e.mme.setParam(target, w.effect.folder, w.effect.path, w.name, w.value);
  if (writes.size) {
    const now = new Map(mmeParams(e, target).flatMap(x => x.channels.map((ch, i) => [ch, x.p.value[i]] as const)));
    for (const w of writes.values()) for (const ch of w.channels) result[ch] = now.get(ch) ?? 0;
  }
  return { object: target === 'stage' ? 'stage' : target.id, values: result };
}

// insert_keyframe の channels: MME のチャンネル (名前は mme_state・mme_set_values と同じ) にキーを打つ。値のないチャンネルは、いまの値 (既定) を入れてから
function keyMmeChannels(e: Engine, target: Obj, channels: unknown) {
  if (!Array.isArray(channels) || channels.length === 0 || !channels.every(c => typeof c === 'string')) throw new Error(t('channels に値の名前を渡してください'));
  const table = mmeValueTable(e, target);
  for (const name of channels as string[]) if (!table.has(name) && target.mmeValues?.[name] === undefined) throw unknownValue(name);
  return (frame: number) => {
    const own = (target.mmeValues ??= {});
    for (const name of channels as string[]) {
      if (own[name] !== undefined) continue;
      mmeChannel(target, name);
      own[name] = table.get(name)!;
    }
    e.keyframes.insertMme(target, frame, channels as string[]);
    if (frame > e.clock.end) e.clock.setRange(e.clock.start, frame);
    e.mme.publish();
  };
}

// fx/ の一覧 (アプリを配るサーバーに聞く。なければエラー)
async function fxListing() {
  const listing = await listFxFolder();
  if (!listing) throw new Error(t('fx/ の一覧を取れません (アプリを配るサーバーがないか、fx/ にエフェクトがありません)'));
  return listing;
}

// MME の状態 (mme_state)
function mmeState(e: Engine) {
  const ui = mmeUi(e);
  const objects = e.world.objects;
  const accessories = objects.filter(o => o.mmeObj?.kind === 'accessory').map(o => {
    const main = o.mme?.Main?.object;
    const post = ui.posts.find(x => x.objId === o.id);
    const own = o.mmeValues ?? {};
    return {
      id: o.id, name: nameOf(o), enabled: !o.hidden && !o.colHidden && !o.hideRender,
      values: Object.fromEntries(ACCESSORY_ITEMS.map(k => [k, own[k] ?? ACCESSORY_DEFAULTS[k]])),
      fx: main ? slotJson(e, main) : null,
      ...(post ? { ok: post.ok, ...(post.ok ? {} : { errors: post.errors }), warnings: post.warnings } : {}),
    };
  });
  // コントローラー: 描いているエフェクトが読む名前 (場面になければ id は null、値は 0) と、置いてあるコントローラー
  const listed = new Map<string, { name: string; id: number | null; items: Record<string, number> }>();
  const itemsOf = (obj: Obj | undefined, names: readonly string[]) => Object.fromEntries([...new Set([...names, ...(obj?.mmeChannels ?? [])])].map(n => [n, obj?.mmeValues?.[n] ?? 0]));
  for (const c of ui.controllers) listed.set(c.name, { name: c.name, id: c.objId, items: itemsOf(c.objId === null ? undefined : e.world.find(c.objId) ?? undefined, c.items) });
  for (const o of objects) if (o.mmeObj?.kind === 'controller' && ![...listed.values()].some(c => c.id === o.id)) listed.set(o.mmeObj.name + `#${o.id}`, { name: o.mmeObj.name, id: o.id, items: itemsOf(o, []) });
  const controllers = [...listed.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const targets: (Obj | 'stage')[] = [...(ui.rows.Main?.some(r => r.objId === STAGE_ROW_ID) ? ['stage' as const] : []), ...objects.filter(o => !o.light && !o.camera)];
  const params = targets.flatMap(target => mmeParams(e, target).map(({ effect, p, channels }) => ({
    object: target === 'stage' ? 'stage' : target.id, effect, name: p.name, label: p.label, type: p.type, min: p.min, max: p.max, color: p.color, channels, value: p.value,
  })));
  return {
    settings: { ...ui.settings }, folders: ui.folders.map(f => ({ ...f, fx: [...f.fx] })), tabs: ui.tabs, assignments: mmeAssignments(e),
    accessories, controllers, params, warnings: [...ui.warnings],
  };
}

const blobToBase64 = async (b: Blob) => toBase64(new Uint8Array(await b.arrayBuffer()));
// MCP サーバーが読んだ元の場所は、File に sourcePath として付けておく
const toFiles = (files: RemoteFile[]) => files.map(f => {
  const file = new File([fromBase64(f.data) as BlobPart], f.name, { type: f.type ?? '' });
  if (f.path) Object.defineProperty(file, 'sourcePath', { value: f.path });
  return file;
});

export const COMMANDS: Record<string, Command> = {
  get_state: e => sceneState(e),
  screenshot: (e, p) => screenshot(e, Number(p?.maxSize) || 1024),

  // --- 物 ---
  add_shape: (e, p) => {
    if (e.world.full) throw new Error('これ以上置けません (32 個まで)');
    e.addShape(shapeIndex(p?.shape ?? 'cube'));
    const obj = e.selection.current!;
    if (p?.color !== undefined) e.world.setShapeColor(obj, colorIndex(p.color));
    if (p?.x !== undefined || p?.z !== undefined) COMMANDS.set_object(e, { id: obj.id, x: p.x, z: p.z });
    return { id: obj.id };
  },
  select: (e, p) => {
    if (Array.isArray(p?.ids)) { e.selection.setMany((p.ids as number[]).map(id => objOf(e, id))); e.viewport.requestDraw(); }
    else e.selectById(p?.id ?? null);
    return { selected: e.selection.current?.id ?? null, selectedIds: e.selection.list.map(o => o.id) };
  },
  set_object: (e, p) => {
    const obj = objOf(e, p?.id);
    if (p.x !== undefined) obj.x = Number(p.x);
    if (p.z !== undefined) obj.z = Number(p.z);
    if (p.rotationDeg !== undefined) obj.r = Number(p.rotationDeg) / DEG;
    if (p.color !== undefined) {
      if (isModel(obj)) throw new Error('MMD モデルの色は set_material で変えます');
      e.world.setShapeColor(obj, colorIndex(p.color));
    }
    if (p.scale !== undefined) {
      if (!canScale(obj)) throw new Error('大きさを変えられるのは形と MMD モデルだけです');
      e.setScale(obj, Number(p.scale));
    }
    if (p.parent !== undefined) {
      const parent = p.parent === null ? null : objOf(e, p.parent);
      if (!e.hierarchy.set(obj, parent)) throw new Error('親の子孫は、その親の親にできません');
    }
    if (p.collection !== undefined) { e.select(obj); e.moveToCollection(p.collection === null ? null : String(p.collection)); }
    if (p.name !== undefined) e.renameObj(obj, p.name === null ? null : String(p.name));
    if (p.hidden !== undefined || p.hideRender !== undefined) e.setVisibility(obj, { hidden: p.hidden === undefined ? undefined : !!p.hidden, hideRender: p.hideRender === undefined ? undefined : !!p.hideRender });
    e.world.settle();
    e.selection.publish();
    e.viewport.requestDraw();
    return { id: obj.id, position: [r3(obj.x), r3(obj.y), r3(obj.z)] };
  },
  // ライト: 置く・変える
  add_light: (e, p) => {
    const { type = 'point', x, z, ...settings } = p ?? {};
    const obj = e.addLight(type, settings);
    if (!obj) throw new Error('これ以上置けません');
    if (x !== undefined || z !== undefined) COMMANDS.set_object(e, { id: obj.id, x, z });
    return { id: obj.id, light: obj.light };
  },
  add_camera: (e, p) => {
    const { x, z, rotationDeg, ...settings } = p ?? {};
    const obj = e.addCamera(settings);
    if (!obj) throw new Error('これ以上置けません');
    if (x !== undefined || z !== undefined || rotationDeg !== undefined) COMMANDS.set_object(e, { id: obj.id, x, z, rotationDeg });
    return { id: obj.id, camera: obj.camera };
  },
  set_camera_object: (e, p) => {
    const obj = objOf(e, p?.id);
    if (!obj.camera) throw new Error(`id ${obj.id} はカメラではありません`);
    e.select(obj);
    const { id: _id, ...patch } = p ?? {};
    e.setCamera(patch);
    return { id: obj.id, camera: obj.camera };
  },
  set_light: (e, p) => {
    const obj = objOf(e, p?.id);
    if (!obj.light) throw new Error(`id ${obj.id} はライトではありません`);
    e.select(obj);
    const { id: _id, ...patch } = p ?? {};
    e.setLight(patch);
    return { id: obj.id, light: obj.light };
  },
  duplicate_object: async (e, p) => {
    e.select(objOf(e, p?.id));
    const obj = await e.duplicateSelected();
    if (!obj) throw new Error('複製できませんでした (これ以上置けないか、モデルのファイルがありません)');
    return { id: obj.id, name: obj.name };
  },
  reorder_objects: (e, p) => {
    const ids = (p?.ids ?? []) as number[];
    for (const id of ids) objOf(e, id);
    e.setOrder(ids);
    return { order: e.world.objects.map(o => o.id) };
  },
  delete_object: (e, p) => { e.world.remove(objOf(e, p?.id)); return { ok: true }; },
  reset_scene: e => { e.resetAll(); return { ok: true }; },

  // --- ファイル (MMD モデルとテクスチャ・.vmd・.vpd・曲) ---
  load_files: async (e, p) => {
    const files = toFiles(p?.files ?? []);
    if (!files.length) throw new Error('ファイルがありません');
    const before = e.world.objects.length;
    await e.loadFiles(files, { askTextures: false }); // (外からの操作では、画面で聞かない)
    return { message: e.ui.state.toast?.text ?? null, added: e.world.objects.slice(before).map(o => o.id), state: sceneState(e) };
  },

  // --- タイムライン ---
  timeline: (e, p) => {
    const { clock } = e;
    if (p?.start !== undefined || p?.end !== undefined) clock.setRange(p.start ?? clock.start, p.end ?? clock.end);
    if (p?.frame !== undefined) clock.seekFrame(Number(p.frame));
    if (p?.playing !== undefined && !!p.playing !== clock.playing) clock.setPlaying(!!p.playing);
    return sceneState(e).timeline;
  },
  insert_keyframe: (e, p) => {
    const target = objOf(e, p?.id);
    // channels: MME のチャンネルだけにキーを打つ (名前が壊れていれば、フレームを動かさずにエラー)
    const keyChannels = p?.channels !== undefined ? keyMmeChannels(e, target, p.channels) : null;
    if (p?.frame !== undefined) e.clock.seekFrame(Number(p.frame));
    e.select(target);
    if (keyChannels) { keyChannels(e.clock.frame); return { frame: e.clock.frame, keyframes: keyFrames(target.anim) }; }
    // 形・ライト・MME の物 (値の全部): 位置・回転・大きさのキー
    if (!isModel(target)) { e.insertKey(); return { frame: e.clock.frame, keyframes: keyFrames(target.anim) }; }
    const obj = target;
    if (p?.bones?.length) {
      const bones = (p.bones as unknown[]).map(b => boneIndex(obj, b));
      e.keyframes.insert(obj, e.clock.frame, bones);
    } else e.insertKey();
    return { frame: e.clock.frame, keyframes: keyFrames(obj.anim) };
  },
  delete_keyframe: (e, p) => {
    const obj = objOf(e, p?.id);
    if (p?.frame !== undefined) e.clock.seekFrame(Number(p.frame));
    e.select(obj);
    e.deleteKeyHere();
    return { keyframes: keyFrames(obj.anim) };
  },

  // --- ポーズ・表情 ---
  list_bones: (e, p) => {
    const obj = modelOf(e, p?.id);
    return e.posing.boneGroups(obj).map(g => ({ group: g.label, bones: g.bones.map(b => b.name) }));
  },
  set_bone: (e, p) => {
    const obj = modelOf(e, p?.id);
    const i = boneIndex(obj, p?.bone);
    const keys: [keyof BoneValue, unknown][] = [
      ['rx', p.rotationDeg?.[0]], ['ry', p.rotationDeg?.[1]], ['rz', p.rotationDeg?.[2]],
      ['px', p.position?.[0]], ['py', p.position?.[1]], ['pz', p.position?.[2]],
    ];
    for (const [k, v] of keys) if (v !== undefined && v !== null) e.posing.setBone(obj, i, k, Number(v));
    return { bone: obj.model.skeleton.bones[i].name, value: e.posing.boneValue(obj, i) };
  },
  reset_pose: (e, p) => { e.posing.resetPose(modelOf(e, p?.id)); return { ok: true }; },
  list_morphs: (e, p) => {
    const obj = modelOf(e, p?.id);
    return e.posing.morphs(obj).map(m => ({ name: m.name, value: r3(e.posing.morphValue(obj, m.index)) }));
  },
  set_morph: (e, p) => {
    const obj = modelOf(e, p?.id);
    const m = e.posing.morphs(obj).find(m => m.name === p?.name);
    if (!m) throw new Error(`表情 ${p?.name} はありません (list_morphs で名前を確かめてください)`);
    e.posing.setMorph(obj, m.index, Math.min(Math.max(Number(p.value), 0), 1));
    e.viewport.requestDraw();
    return { name: m.name, value: e.posing.morphValue(obj, m.index) };
  },
  set_hair_hang: (e, p) => {
    const obj = modelOf(e, p?.id);
    e.physics.setHairHang(obj, !!p?.on);
    e.viewport.requestDraw();
    return { hairHang: e.physics.hairHang(obj) };
  },

  // --- 視点 ---
  set_camera: (e, p) => {
    const { camera } = e;
    if (camera.override) camera.releaseOverride(false); // 自分で動かすと、カメラモーションはやめる (画面と同じ)
    if (p?.view) camera.snapView(String(p.view));
    const cam = camera.cam;
    if (p?.yawDeg !== undefined) cam.yaw = Number(p.yawDeg) / DEG;
    if (p?.pitchDeg !== undefined) cam.pitch = Math.min(Math.max(Number(p.pitchDeg) / DEG, -1.5), 1.5);
    if (p?.distance !== undefined) cam.dist = Math.max(Number(p.distance), 0.1);
    if (p?.target) [cam.tx, cam.ty, cam.tz] = (p.target as number[]).map(Number);
    if (p?.fov !== undefined) cam.fov = Math.min(Math.max(Number(p.fov), 5), 120);
    if (p?.yawDeg !== undefined || p?.pitchDeg !== undefined) camera.viewName = '';
    if (p?.shading !== undefined) {
      if (!SHADING_MODES.includes(p.shading as ShadingMode)) throw new Error(`shading は ${SHADING_MODES.join(' / ')} のどれかです`);
      e.shading.set(p.shading as ShadingMode);
    }
    e.viewport.requestDraw();
    return sceneState(e).camera;
  },

  // --- マテリアル ---
  list_materials: e => [...e.library.materials.values()].map(m => {
    const bsdf = surfaceShader(m.tree);
    const inputs = bsdf ? Object.fromEntries(NODE_TYPES.principled.inputs.filter(s => !s.noValue).map(s => {
      const v = bsdf.values[s.id] ?? s.default;
      return [s.id, Array.isArray(v) ? linearToHex(v as [number, number, number]) : v];
    })) : {};
    return { id: m.id, name: m.name, users: e.library.users(m.id), inputs, settings: m.settings, outline: m.outline };
  }),
  set_material: (e, p) => {
    const lib = e.library;
    let id: string | null | undefined = [...lib.materials.values()].find(m => m.id === p?.material || m.name === p?.material)?.id;
    if (!id && p?.id !== undefined) id = objOf(e, p.id).slots[Number(p.slot ?? 0)];
    if (!id) throw new Error('マテリアルが見つかりません (material に名前か id、または物の id と slot を指定してください)');
    const valid = new Map(NODE_TYPES.principled.inputs.map(s => [s.id, s]));
    lib.edit(id, d => {
      const bsdf = surfaceShader(d.tree);
      for (const [k, v] of Object.entries(p?.inputs ?? {})) {
        const def = valid.get(k);
        if (!def || def.noValue || !bsdf) throw new Error(`入力 ${k} はありません (${[...valid.keys()].join(', ')})`);
        bsdf.values[k] = def.kind === 'color' ? (typeof v === 'string' ? hexToLinear(v) : (v as number[]).map(Number)) as never : Number(v);
      }
      if (p?.settings) Object.assign(d.settings, p.settings);
      if (p?.outline) Object.assign(d.outline, p.outline);
    });
    if (p?.name) lib.rename(id, String(p.name));
    e.viewport.requestDraw();
    return { id, name: lib.materials.get(id)!.name };
  },

  // --- 効果・出力 ---
  set_effect: async (e, p) => {
    const k = p?.effect as FxKey;
    if (!(k in e.ui.state.fxState)) throw new Error(`効果は ${Object.keys(e.ui.state.fxState).join(' / ')} のどれかです`);
    if (p?.levels) for (const [lk, v] of Object.entries(p.levels)) e.effects.setLevel(lk as keyof FxLevel, Number(v));
    if (p?.enabled !== undefined) await e.effects.set(k, !!p.enabled);
    return { enabled: e.ui.state.fxState, levels: e.ui.state.fxLevel };
  },
  // シーンの設定 (空・床・太陽・部屋の光)。渡したところだけ変える
  set_scene: (e, p) => { e.environment.set(p ?? {}); return e.environment.settings; },
  set_output: (e, p) => { e.output.set((p ?? {}) as Partial<OutputSettings>); return e.output.settings; },
  render_image: async (e, p) => {
    if (p?.frame !== undefined) e.clock.seekFrame(Number(p.frame));
    const blob = await e.output.renderPng();
    const { w, h } = regionPixels(e.output.settings);
    return { png: await blobToBase64(blob), width: w, height: h, frame: e.clock.frame };
  },
  render_animation: async e => {
    const r = await e.output.renderVideo();
    return { data: toBase64(r.bytes), ext: r.ext, mime: r.mime, codec: r.codec, frames: r.frames };
  },

  // --- アドオン ---
  list_addons: e => e.addons.list(),
  set_addon: async (e, p) => {
    const id = String(p?.id ?? '');
    if (p?.enabled === false) e.addons.disable(id); else await e.addons.enable(id);
    const a = e.addons.list().find(x => x.id === id);
    if (a?.error) throw new Error(`有効にできませんでした: ${a.error}`);
    return a;
  },
  // 有効なアドオンが足した命令 (名前は "アドオンの id.命令")
  list_commands: e => e.addons.commands.list().filter(c => c.source).map(c => ({ name: c.key, addon: c.source, description: c.description ?? '', params: c.params ?? {} })),
  run_command: (e, p) => {
    const name = String(p?.name ?? '');
    if (!e.addons.commands.get(name)?.source) throw new Error(`アドオンの命令 ${name} はありません (list_commands で確かめてください。アドオンが切ってあれば set_addon で有効にします)`);
    return runCommand(e, name, p?.params ?? {});
  },

  // --- MME 互換 (標準 / MME のレンダーエンジン・エフェクト割当) ---
  mme_state: e => mmeState(e),
  // 設定を、渡したところだけ変える
  mme_set: (e, p) => {
    const s = p?.settings;
    if (!isRecord(s) || Object.keys(s).length === 0) throw new Error(t('settings を渡してください'));
    const patch: Partial<MmeSettings> = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === 'engine') {
        if (v !== 'standard' && v !== 'mme') throw new Error(t('engine は standard か mme です'));
        patch.engine = v;
      } else if (k === 'selfShadow' || k === 'groundShadow') {
        if (typeof v !== 'boolean') throw new Error(t('{name} は true か false です', { name: k }));
        patch[k] = v;
      } else if (k === 'shadowDistance') {
        if (!finiteNumber(v)) throw new Error(t('shadowDistance は数です'));
        patch.shadowDistance = normalizeMme({ shadowDistance: v }).shadowDistance;
      } else throw new Error(t('設定 {name} はありません (engine・selfShadow・shadowDistance・groundShadow)', { name: k }));
    }
    e.mme.set(patch);
    return { ...e.mme.settings };
  },
  // fx/ のフォルダの一覧 (フォルダごとに .fx のパスと大きさ)
  mme_list_fx: async e => {
    const loaded = new Set(e.mme.store.folders().map(f => f.name));
    return {
      folders: (await fxListing()).folders.map(f => ({ name: f.name, fx: f.fx, files: f.files.length, bytes: f.size, ...(f.truncated ? { truncated: true } : {}), loaded: loaded.has(f.name) })),
    };
  },
  // fx/ のフォルダを読み込む (画面の「fx/ から選ぶ」と同じ。読み込むだけで、当てはしない)
  mme_load_folder: async (e, p) => {
    const name = typeof p?.folder === 'string' ? p.folder.trim() : '';
    if (!name) throw new Error(t('folder にフォルダの名前を渡してください'));
    const { folders } = await fxListing();
    const entry = folders.find(f => f.name === name) ?? folders.find(f => f.name.toLowerCase() === name.toLowerCase());
    if (!entry) throw new Error(t('fx/ にフォルダ {name} はありません ({list})', { name, list: listOf(folders.map(f => f.name)) }));
    let files: File[];
    try {
      files = await fetchFxFiles(entry);
    } catch (err) {
      throw new Error(t('{name} を読み込めませんでした: {error}', { name: entry.name, error: errorText(err) }), { cause: err });
    }
    if (entry.truncated) e.ui.toast(t('{name} はファイルが多いか深すぎるので、一部だけ読み込みました', { name: entry.name }), 8000);
    const folder = await e.mme.store.addFolder(files);
    return { folder: { id: folder.id, name: folder.name }, fx: entry.fx, ...(entry.truncated ? { truncated: true } : {}) };
  },
  // 物 (id か 'stage') のタブの、物全体か材質の割り当て。fx は { folder, path }・'hide' (描かない)・null (外す)
  mme_assign: (e, p) => {
    const target = mmeTarget(e, p?.object);
    const tab = String(p?.tab ?? 'Main');
    const ui = mmeUi(e);
    if (!ui.tabs.some(x => x.name === tab)) throw new Error(t('タブ {tab} はありません ({list})', { tab, list: listOf(ui.tabs.map(x => x.name)) }));
    const material = p?.material === undefined || p.material === null ? null : Number(p.material);
    const id = target === 'stage' ? STAGE_ROW_ID : target.id;
    const rows = (ui.rows[tab] ?? []).filter(r => r.objId === id);
    if (!ui.rows[tab]) throw new Error(t('タブ {tab} は、いまは描く宣言がないので割り当てられません', { tab }));
    if (!rows.length) throw new Error(t('id {id} の物には .fx を当てられません', { id }));
    if (material !== null && !rows.some(r => r.material === material)) throw new Error(t('材質 {n} はありません', { n: String(p.material) }));
    if (p?.fx === undefined) throw new Error(t('fx は { folder, path } か "hide" か null です'));
    const slot = p.fx === null ? null : p.fx === 'hide' ? 'hide' : fxSlot(e, p.fx);
    if (target === 'stage') e.mme.assignStage(tab, material, slot);
    else e.mme.assign(target, tab, material, slot);
    return { object: target === 'stage' ? 'stage' : target.id, tab, material, fx: slot && slotJson(e, slot) };
  },
  // アクセサリ (ポストエフェクトの .fx を当てる物) を置く。fx があれば Main の物全体に当てる
  mme_add_accessory: (e, p) => {
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    if (!name) throw new Error(t('name に名前を渡してください'));
    const slot = p?.fx === undefined || p.fx === null ? null : fxSlot(e, p.fx); // (壊れていれば、物を置く前にエラー)
    const obj = e.addMmeObject({ kind: 'accessory', name });
    if (slot) e.mme.assign(obj, 'Main', null, slot);
    return { id: obj.id, name: obj.name, kind: 'accessory', ...(slot ? { fx: slotJson(e, slot) } : {}) };
  },
  // 仮のコントローラーを置く (描いているエフェクトが同じ名前で読む)
  mme_add_controller: (e, p) => {
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    if (!name) throw new Error(t('name に名前を渡してください'));
    const have = e.mme.controllers.controller(name);
    if (have) throw new Error(t('コントローラー {name} はもう置いてあります (id {id})', { name, id: have.id }));
    const obj = e.addMmeObject({ kind: 'controller', name });
    return { id: obj.id, name: obj.name, kind: 'controller' };
  },
  // コントローラーの項目・アクセサリの X〜Tr・.fx のパラメータ (チャンネルの名前) の値を書く
  mme_set_values: (e, p) => setMmeValues(e, mmeTarget(e, p?.object), p?.values),
  // .emm (base64) を読んで割り当てを戻す
  mme_import_emm: (e, p) => {
    if (typeof p?.data !== 'string' || !p.data) throw new Error(t('data に .emm を base64 で渡してください'));
    return e.mme.importEmm(fromBase64(p.data));
  },
  mme_export_emm: e => ({ data: toBase64(e.mme.exportEmm()) }),

  // --- プロジェクト ---
  // reference: ファイルは参照だけ (.wgpj の JSON)
  save_project: async (e, p) => ({ data: toBase64(await e.project.save(p?.reference ? 'reference' : 'embedded')) }),
  // files: 参照しているファイル (MCP サーバーが探したもの)。見つからないものがあればエラー (allowMissing なら、なしで開く)
  open_project: async (e, p) => {
    const files: RemoteFile[] = p?.files ?? [];
    const provided = new Map(toFiles(files).map((f, i) => [files[i].asset ?? '', f]));
    let skipped: string[] = [];
    const { notes } = await e.project.open(fromBase64(String(p?.data ?? '')), {
      provided,
      pick: async missing => {
        skipped = missing.map(a => a.name);
        if (p?.allowMissing) return 'skip';
        throw new Error(`参照しているファイルが見つかりません: ${skipped.join('、')}`);
      },
    });
    if (p?.name) e.ui.set({ projectName: projectBaseName(String(p.name)) });
    return { missing: skipped, notes, ...sceneState(e) }; // notes: 開いたときの知らせ (古い MME の値の移し替えで合わなかったもの)
  },
};

// 1 つの命令を実行する (知らない名前はエラー)
// (本体の命令と、アドオンが登録した命令。Addons.commands から引く)
export async function runCommand(e: Engine, method: string, params: unknown) {
  const cmd = e.addons.commands.get(method);
  if (!cmd) throw new Error(`知らない命令です: ${method}`);
  return await cmd.run(e, params);
}
