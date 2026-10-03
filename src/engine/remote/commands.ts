import { FPS, PALETTE_NAMES, VIEWPORT_BG } from '../../core/constants';
import { SHAPES, findShape } from '../../core/shapes';
import { hexToLinear, linearToHex } from '../../core/materials/color';
import { NODE_TYPES } from '../../core/materials/nodes';
import { surfaceShader } from '../../core/materials/tree';
import type { OutputSettings } from '../../core/output';
import { fromBase64, toBase64, type RemoteFile } from '../../core/remote';
import { keyFrames } from '../../core/animation';
import type { BoneValue } from '../../core/types';
import type { Engine } from '../Engine';
import { nameOf } from '../world/Selection';
import { projectBaseName } from '../project/ProjectIO';
import type { FxKey, FxLevel } from '../render/postfx';
import { isModel, kindOf, type Any, type ModelObj, type Obj } from '../types';

// --- 外部 (MCP) から使える操作 ---
// 名前 → (エンジン, 引数) → 結果 (JSON にできる値)。ファイルは base64 でやりとりする。
// 画面の操作と同じ Engine の操作を呼ぶので、画面にもそのまま反映される
export type Command = (e: Engine, p: Any) => unknown;

const DEG = 180 / Math.PI;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function objOf(e: Engine, id: unknown): Obj {
  const obj = id === undefined || id === null ? e.selection.current : e.world.find(Number(id));
  if (!obj) throw new Error(id === undefined || id === null ? '物を選んでいません。id を指定してください' : `id ${id} の物はありません`);
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
    objects: e.world.objects.map(o => ({
      id: o.id,
      kind: kindOf(o),
      name: nameOf(o),
      ...(o.light ? { light: o.light } : {}),
      position: [r3(o.x), r3(o.y), r3(o.z)],
      rotationDeg: r3(o.r * DEG),
      ...(isModel(o)
        ? { motion: o.motionFile?.name ?? null, keyframes: keyFrames(o.anim), hairHang: e.physics.hairHang(o) }
        : { color: PALETTE_NAMES[o.c] }),
      materials: o.slots.map(id => (id ? lib.materials.get(id)?.name ?? null : null)),
      ...(o.addonData && Object.keys(o.addonData).length ? { addons: o.addonData } : {}), // アドオンの、物ごとの値
    })),
    stage: e.stage.model?.name ?? null,
    music: e.music.file?.name ?? null,
    cameraMotion: e.motion.camera ? e.motion.cameraFile?.name ?? '(あり)' : null,
    camera: { yawDeg: r3(cam.yaw * DEG), pitchDeg: r3(cam.pitch * DEG), distance: r3(cam.dist), target: [r3(cam.tx), r3(cam.ty), r3(cam.tz)], fov: cam.fov, view: e.camera.viewName || null },
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
  select: (e, p) => { e.selectById(p?.id ?? null); return { selected: e.selection.current?.id ?? null }; },
  set_object: (e, p) => {
    const obj = objOf(e, p?.id);
    if (p.x !== undefined) obj.x = Number(p.x);
    if (p.z !== undefined) obj.z = Number(p.z);
    if (p.rotationDeg !== undefined) obj.r = Number(p.rotationDeg) / DEG;
    if (p.color !== undefined) {
      if (isModel(obj)) throw new Error('MMD モデルの色は set_material で変えます');
      e.world.setShapeColor(obj, colorIndex(p.color));
    }
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
  set_light: (e, p) => {
    const obj = objOf(e, p?.id);
    if (!obj.light) throw new Error(`id ${obj.id} はライトではありません`);
    e.select(obj);
    const { id: _id, ...patch } = p ?? {};
    e.setLight(patch);
    return { id: obj.id, light: obj.light };
  },
  delete_object: (e, p) => { e.world.remove(objOf(e, p?.id)); return { ok: true }; },
  reset_scene: e => { e.resetAll(); return { ok: true }; },

  // --- ファイル (MMD モデルとテクスチャ・.vmd・.vpd・曲) ---
  load_files: async (e, p) => {
    const files = toFiles(p?.files ?? []);
    if (!files.length) throw new Error('ファイルがありません');
    const before = e.world.objects.length;
    await e.loadFiles(files);
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
    const obj = modelOf(e, p?.id);
    if (p?.frame !== undefined) e.clock.seekFrame(Number(p.frame));
    e.select(obj);
    if (p?.bones?.length) {
      const bones = (p.bones as unknown[]).map(b => boneIndex(obj, b));
      e.keyframes.insert(obj, e.clock.frame, bones);
    } else e.insertKey();
    return { frame: e.clock.frame, keyframes: keyFrames(obj.anim) };
  },
  delete_keyframe: (e, p) => {
    const obj = modelOf(e, p?.id);
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
    return { png: await blobToBase64(blob), width: e.output.settings.width, height: e.output.settings.height, frame: e.clock.frame };
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

  // --- プロジェクト ---
  // reference: ファイルは参照だけ (.wgpj の JSON)
  save_project: async (e, p) => ({ data: toBase64(await e.project.save(p?.reference ? 'reference' : 'embedded')) }),
  // files: 参照しているファイル (MCP サーバーが探したもの)。見つからないものがあればエラー (allowMissing なら、なしで開く)
  open_project: async (e, p) => {
    const files: RemoteFile[] = p?.files ?? [];
    const provided = new Map(toFiles(files).map((f, i) => [files[i].asset ?? '', f]));
    let skipped: string[] = [];
    await e.project.open(fromBase64(String(p?.data ?? '')), {
      provided,
      pick: async missing => {
        skipped = missing.map(a => a.name);
        if (p?.allowMissing) return 'skip';
        throw new Error(`参照しているファイルが見つかりません: ${skipped.join('、')}`);
      },
    });
    if (p?.name) e.ui.set({ projectName: projectBaseName(String(p.name)) });
    return { missing: skipped, ...sceneState(e) };
  },
};

// 1 つの命令を実行する (知らない名前はエラー)
// (本体の命令と、アドオンが登録した命令。Addons.commands から引く)
export async function runCommand(e: Engine, method: string, params: unknown) {
  const cmd = e.addons.commands.get(method);
  if (!cmd) throw new Error(`知らない命令です: ${method}`);
  return await cmd.run(e, params);
}
