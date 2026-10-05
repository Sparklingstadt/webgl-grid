import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeShiftJis } from '../../core/sjis';
import { fromBase64, toBase64 } from '../../core/remote';
import { runCommand } from './commands';
import { Engine } from '../Engine';
import { fetchFxFiles, listFxFolder } from '../io/fxFolder';
import { engineWithCube } from '../testEngine';

// (fx/ の一覧はアプリを配るサーバーに聞くので、テストでは差し替える)
vi.mock('../io/fxFolder', () => ({ listFxFolder: vi.fn(async () => null), fetchFxFiles: vi.fn(async () => []) }));

// 描画先なしのエンジンで、外部 (MCP) からの命令を確かめる
describe('外部からの命令', () => {
  it('形を置き、動かし (積み重ね)、色を変え、消す', async () => {
    const e = engineWithCube();
    const { id } = await runCommand(e, 'add_shape', { shape: 'pyramid', x: 4, z: 2, color: '青' }) as { id: number };
    let s = await runCommand(e, 'get_state', {}) as { objects: { id: number; name: string; position: number[]; color: string }[]; selected: number };
    expect(s.objects.find(o => o.id === id)).toMatchObject({ name: '三角錐', position: [4, 0, 2], color: '青' });
    expect(s.selected).toBe(id);
    await runCommand(e, 'set_object', { id: 1, x: 4, z: 2, color: 5 });
    s = await runCommand(e, 'get_state', {}) as typeof s;
    expect(s.objects.find(o => o.id === 1)).toMatchObject({ color: '緑' });
    expect(Math.max(...s.objects.map(o => o.position[1]))).toBeGreaterThan(0); // 同じ場所なので、どちらかが上に積まれた
    await runCommand(e, 'set_object', { id: 1, name: '台', hidden: true, hideRender: true });
    s = await runCommand(e, 'get_state', {}) as typeof s;
    expect(s.objects.find(o => o.id === 1)).toMatchObject({ name: '台', hidden: true, hideRender: true });
    await runCommand(e, 'set_object', { id: 1, name: null, hidden: false });
    s = await runCommand(e, 'get_state', {}) as typeof s;
    expect(s.objects.find(o => o.id === 1)).toMatchObject({ name: '立方体', hideRender: true });
    expect(s.objects.find(o => o.id === 1)).not.toHaveProperty('hidden');
    expect(await runCommand(e, 'duplicate_object', { id: 1 })).toMatchObject({ name: '立方体.001' });
    await runCommand(e, 'delete_object', { id: e.world.objects.at(-1)!.id });
    expect(await runCommand(e, 'reorder_objects', { ids: [id] })).toEqual({ order: [id, 1] });
    await expect(runCommand(e, 'reorder_objects', { ids: [42] })).rejects.toThrow('id 42 の物はありません');
    await runCommand(e, 'delete_object', { id });
    expect(e.world.objects.map(o => o.id)).toEqual([1]);
  });
  it('タイムラインと形のマテリアル', async () => {
    const e = engineWithCube();
    expect(await runCommand(e, 'timeline', { start: 10, end: 40, frame: 20 })).toMatchObject({ start: 10, end: 40, frame: 20 });
    await runCommand(e, 'set_material', { id: 1, inputs: { baseColor: '#00ff00', metallic: 1 }, name: '金属' });
    const m = (await runCommand(e, 'list_materials', {}) as { name: string; inputs: Record<string, unknown> }[]).find(m => m.name === '金属')!;
    expect(m.inputs).toMatchObject({ baseColor: '#00ff00', metallic: 1 });
  });
  it('分からない命令・ない物・モデルがないときは、分かるエラー', async () => {
    const e = engineWithCube();
    await expect(runCommand(e, 'rm_rf', {})).rejects.toThrow('知らない命令です');
    await expect(runCommand(e, 'toString', {})).rejects.toThrow('知らない命令です');
    await expect(runCommand(e, 'set_object', { id: 99, x: 1 })).rejects.toThrow('id 99 の物はありません');
    await expect(runCommand(e, 'set_bone', { bone: '右腕', rotationDeg: [0, 0, 1] })).rejects.toThrow('MMD モデルではありません');
    await expect(runCommand(e, 'add_shape', { shape: 'dodecahedron' })).rejects.toThrow('形は');
  });
});

// --- MME 互換 (割り当て・アクセサリ・コントローラー・パラメータ・.emm) ---
function fileAt(path: string, text: string): File {
  const f = new File([text], path.slice(path.lastIndexOf('/') + 1));
  Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
}
const POST_FX = `float Strength < float UIMin = 0; float UIMax = 4; > = 1;
float3 Col < string UIWidget = "Color"; > = {1, 0, 0};
float4 VS(float4 p : POSITION) : POSITION { return p; }
float4 PS() : COLOR0 { return float4(Col * Strength, 1); }
technique Post < string Script = "ScriptExternal=Color; Pass=P;"; > { pass P < string Script = "Draw=Buffer;"; > { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }`;
// .pmx を読んだ MMD モデルの代わり (材質 n 個。ポーズの計算は止める)
function model(e: Engine, file: string, n = 3) {
  vi.spyOn(e.posing, 'solve').mockResolvedValue(undefined);
  const mats = Array.from({ length: n }, () => new THREE.MeshBasicMaterial());
  const mesh = Object.assign(new THREE.Mesh(new THREE.BoxGeometry(), mats), { skeleton: new THREE.Skeleton([]) });
  mesh.userData.sourceFile = new File([], file);
  return e.world.addModel(mesh, 0, 0, []);
}
// フォルダ Fx (a.fx・sub/b.fx・post.fx) を読む。割り当てに渡す folder は名前でも id でもよい
async function fxFolder(e: Engine) {
  const loaded = await e.mme.loadEffect([fileAt('Fx/a.fx', 'technique T { }'), fileAt('Fx/sub/b.fx', 'technique T { }'), fileAt('Fx/post.fx', POST_FX)], 'a.fx');
  return loaded.folder.id;
}
const run = (e: Engine, method: string, params: unknown = {}) => runCommand(e, method, params) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('MME の命令', () => {
  beforeEach(() => { vi.mocked(listFxFolder).mockResolvedValue(null); vi.mocked(fetchFxFiles).mockResolvedValue([]); });

  it('mme_state: 最初は設定の既定とメインのタブだけ。mme_set で設定を変える (渡したところだけ。影の距離は 0〜9999 に収める)', async () => {
    const e = new Engine();
    expect(await run(e, 'mme_state')).toEqual({
      settings: { engine: 'standard', selfShadow: true, shadowDistance: 8875, groundShadow: true },
      folders: [], tabs: [{ name: 'Main', description: '' }], assignments: [], accessories: [], controllers: [], params: [], warnings: [],
    });
    expect(await run(e, 'mme_set', { settings: { engine: 'mme', shadowDistance: 99999 } })).toEqual({ engine: 'mme', selfShadow: true, shadowDistance: 9999, groundShadow: true });
    expect(e.mme.settings.engine).toBe('mme');
    expect((await run(e, 'mme_state')).settings.engine).toBe('mme');
    await expect(run(e, 'mme_set', { settings: { engine: 'ray' } })).rejects.toThrow('engine は standard か mme です');
    await expect(run(e, 'mme_set', { settings: { selfShadow: 'yes' } })).rejects.toThrow('selfShadow は true か false です');
    await expect(run(e, 'mme_set', { settings: { zoom: 1 } })).rejects.toThrow('設定 zoom はありません');
    await expect(run(e, 'mme_set', {})).rejects.toThrow('settings を渡してください');
    expect(e.mme.settings.engine).toBe('mme'); // (壊れた引数では変えない)
  });

  it('mme_add_controller / mme_add_accessory: 置いて、mme_state に出る。壊れた引数・同じ名前のコントローラー・置けないときはエラー (置かない)', async () => {
    const e = new Engine();
    const c = await run(e, 'mme_add_controller', { name: 'ray_controller.pmx' });
    expect(c).toMatchObject({ id: expect.any(Number), name: 'ray_controller.pmx', kind: 'controller' });
    expect(e.world.find(c.id)?.mmeObj).toEqual({ kind: 'controller', name: 'ray_controller.pmx' });
    await expect(run(e, 'mme_add_controller', { name: 'RAY_controller.pmx' })).rejects.toThrow('コントローラー RAY_controller.pmx はもう置いてあります');
    await expect(run(e, 'mme_add_controller', { name: '  ' })).rejects.toThrow('name に名前を渡してください');
    await expect(run(e, 'mme_add_accessory', {})).rejects.toThrow('name に名前を渡してください');
    expect(e.world.objects).toHaveLength(1);

    const folder = await fxFolder(e);
    const a = await run(e, 'mme_add_accessory', { name: 'ray.x', fx: { folder: 'Fx', path: 'POST.fx' } });
    expect(a).toMatchObject({ name: 'ray.x', kind: 'accessory', fx: { folder, path: 'post.fx' } });
    expect(e.world.find(a.id)?.mme).toEqual({ Main: { object: { folder, path: 'post.fx' } } });
    const plain = await run(e, 'mme_add_accessory', { name: 'plain.x' });
    expect(e.world.find(plain.id)?.mme).toBeUndefined();
    await expect(run(e, 'mme_add_accessory', { name: 'bad.x', fx: { folder: 'Fx', path: 'none.fx' } })).rejects.toThrow('フォルダ Fx に .fx none.fx はありません');
    expect(e.world.objects).toHaveLength(3); // (失敗したときは置かない)

    const state = await run(e, 'mme_state');
    expect(state.accessories).toEqual([
      expect.objectContaining({ id: a.id, name: 'ray.x', values: { X: 0, Y: 0, Z: 0, Rx: 0, Ry: 0, Rz: 0, Si: 1, Tr: 1 }, fx: { folder, folderName: 'Fx', path: 'post.fx' }, enabled: true, ok: true }),
      expect.objectContaining({ id: plain.id, name: 'plain.x', fx: null }),
    ]);
    expect(state.controllers).toEqual([{ name: 'ray_controller.pmx', id: c.id, items: {} }]);

    vi.spyOn(e.world, 'full', 'get').mockReturnValue(true);
    await expect(run(e, 'mme_add_controller', { name: 'other.pmx' })).rejects.toThrow('これ以上置けません');
    await expect(run(e, 'mme_add_accessory', { name: 'other.x' })).rejects.toThrow('これ以上置けません');
  });

  it('mme_assign: 物全体・材質・hide・外す (null)。folder は名前でも id でもよく、.fx のパスは大文字小文字を問わない。mme_state の assignments に出る。1 回の取り消しで戻る', async () => {
    const e = new Engine();
    const folder = await fxFolder(e);
    const miku = model(e, 'miku.pmx');
    e.history.checkpoint();
    expect(await run(e, 'mme_assign', { object: miku.id, tab: 'Main', fx: { folder: 'fx', path: 'SUB/b.fx' } })).toEqual({
      object: miku.id, tab: 'Main', material: null, fx: { folder, folderName: 'Fx', path: 'sub/b.fx' },
    });
    await run(e, 'mme_assign', { object: miku.id, tab: 'Main', material: 1, fx: 'hide' });
    await run(e, 'mme_assign', { object: miku.id, tab: 'Main', material: 2, fx: { folder, path: 'a.fx' } });
    expect(miku.mme).toEqual({ Main: { object: { folder, path: 'sub/b.fx' }, materials: { 1: 'hide', 2: { folder, path: 'a.fx' } } } });
    expect((await run(e, 'mme_state')).assignments).toEqual([
      { object: miku.id, tab: 'Main', material: null, fx: { folder, folderName: 'Fx', path: 'sub/b.fx' } },
      { object: miku.id, tab: 'Main', material: 1, fx: 'hide' },
      { object: miku.id, tab: 'Main', material: 2, fx: { folder, folderName: 'Fx', path: 'a.fx' } },
    ]);
    expect(await run(e, 'mme_assign', { object: miku.id, tab: 'Main', material: 1, fx: null })).toMatchObject({ material: 1, fx: null });
    expect(miku.mme?.Main?.materials).toEqual({ 2: { folder, path: 'a.fx' } });
    e.history.checkpoint();
    await e.history.undo(); // (続けた割り当ては、1 回の取り消しでまとめて戻る)
    expect(miku.mme).toBeUndefined();
  });

  it('mme_assign の壊れた引数: ない物・知らないタブ・ない材質・ない .fx・ない物のフォルダ・ライト・ステージがないとき・fx がないときは、分かるエラーで何も変えない', async () => {
    const e = new Engine();
    const folder = await fxFolder(e);
    const miku = model(e, 'miku.pmx');
    const light = e.addLight('point', {})!;
    const fx = { folder, path: 'a.fx' };
    await expect(run(e, 'mme_assign', { object: 99, tab: 'Main', fx })).rejects.toThrow('id 99 の物はありません');
    await expect(run(e, 'mme_assign', { object: miku.id, tab: 'Nope', fx })).rejects.toThrow('タブ Nope はありません (Main)');
    await expect(run(e, 'mme_assign', { object: miku.id, tab: 'Main', material: 3, fx })).rejects.toThrow('材質 3 はありません');
    await expect(run(e, 'mme_assign', { object: miku.id, tab: 'Main', fx: { folder, path: 'missing.fx' } })).rejects.toThrow('フォルダ Fx に .fx missing.fx はありません');
    await expect(run(e, 'mme_assign', { object: miku.id, tab: 'Main', fx: { folder: 'Gone', path: 'a.fx' } })).rejects.toThrow('フォルダ Gone は読み込んでいません (Fx)');
    await expect(run(e, 'mme_assign', { object: miku.id, tab: 'Main', fx: { path: 'a.fx' } })).rejects.toThrow('fx は { folder, path } か "hide" か null です');
    await expect(run(e, 'mme_assign', { object: miku.id, tab: 'Main' })).rejects.toThrow('fx は { folder, path } か "hide" か null です');
    await expect(run(e, 'mme_assign', { object: light.id, tab: 'Main', fx })).rejects.toThrow(`id ${light.id} の物には .fx を当てられません`);
    await expect(run(e, 'mme_assign', { object: 'stage', tab: 'Main', fx })).rejects.toThrow('ステージがありません');
    expect(miku.mme).toBeUndefined();
  });

  it('mme_assign: ステージの割り当て (場面の値) と、mme_state の assignments の object は "stage"', async () => {
    const e = new Engine();
    const folder = await fxFolder(e);
    const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(), [new THREE.MeshBasicMaterial({ name: '空' })]);
    mesh.userData.sourceFile = new File([], 'sky.pmx');
    const stage = new THREE.Group();
    stage.add(mesh);
    e.stage.model = stage;
    e.graph.scene.add(stage);
    e.ui.set({ sceneVersion: e.ui.state.sceneVersion + 1 });
    await run(e, 'mme_assign', { object: 'stage', tab: 'Main', fx: { folder, path: 'a.fx' } });
    await run(e, 'mme_assign', { object: 'stage', tab: 'Main', material: 0, fx: 'hide' });
    expect(e.mme.saveScene().stage).toEqual({ Main: { object: { folder, path: 'a.fx' }, materials: { 0: 'hide' } } });
    expect((await run(e, 'mme_state')).assignments).toEqual([
      { object: 'stage', tab: 'Main', material: null, fx: { folder, folderName: 'Fx', path: 'a.fx' } },
      { object: 'stage', tab: 'Main', material: 0, fx: 'hide' },
    ]);
  });

  it('mme_assign: オフスクリーンのタブも、描いたときに知らせてくる名前なら使える', async () => {
    const e = new Engine();
    const folder = await fxFolder(e);
    const miku = model(e, 'miku.pmx');
    vi.spyOn(e.mme.renderer, 'offscreenTabs').mockReturnValue([{ name: 'MaterialMap', description: '' }]);
    vi.spyOn(e.mme.renderer, 'offscreenDefaults').mockReturnValue({ defaults: { rules: [], base: null, folder: null }, owners: new Set() } as never);
    await run(e, 'mme_assign', { object: miku.id, tab: 'MaterialMap', fx: { folder, path: 'a.fx' } });
    expect(miku.mme).toEqual({ MaterialMap: { object: { folder, path: 'a.fx' } } });
    expect((await run(e, 'mme_state')).tabs.map((t: { name: string }) => t.name)).toEqual(['Main', 'MaterialMap']);
  });

  it('mme_set_values: コントローラーの項目 (0〜1 に収める)・アクセサリの X〜Tr・パラメータ (成分ごとも、ベクトルまとめても)。ステージのパラメータは場面の値', async () => {
    const e = new Engine();
    const folder = await fxFolder(e);
    const ctl = await run(e, 'mme_add_controller', { name: 'ctl.pmx' });
    expect(await run(e, 'mme_set_values', { object: ctl.id, values: { 'SSAO+': 3, 'Bloom+': 0.25 } })).toEqual({ object: ctl.id, values: { 'SSAO+': 1, 'Bloom+': 0.25 } });
    expect(e.world.find(ctl.id)?.mmeValues).toEqual({ 'SSAO+': 1, 'Bloom+': 0.25 });
    expect((await run(e, 'mme_state')).controllers).toEqual([{ name: 'ctl.pmx', id: ctl.id, items: { 'SSAO+': 1, 'Bloom+': 0.25 } }]);

    const post = await run(e, 'mme_add_accessory', { name: 'post.x', fx: { folder, path: 'post.fx' } });
    const set = await run(e, 'mme_set_values', { object: post.id, values: { X: 2, Si: -5, Tr: 7, [`${folder}/post.fx:Strength`]: 9, [`${folder}/post.fx:Col`]: [0.5, 0.25, 1], [`${folder}/post.fx:Col:y`]: 0.75 } });
    expect(set.values).toEqual({ X: 2, Si: 0, Tr: 1, [`${folder}/post.fx:Strength`]: 4, [`${folder}/post.fx:Col:x`]: 0.5, [`${folder}/post.fx:Col:y`]: 0.75, [`${folder}/post.fx:Col:z`]: 1 });
    expect(e.world.find(post.id)?.mmeValues).toMatchObject({ X: 2, Si: 0, Tr: 1, [`${folder}/post.fx:Strength`]: 4 });
    const params = (await run(e, 'mme_state')).params;
    expect(params).toEqual([
      expect.objectContaining({ object: post.id, effect: { folder, path: 'post.fx', name: 'Fx/post.fx' }, name: 'Strength', type: 'float', min: 0, max: 4, channels: [`${folder}/post.fx:Strength`], value: [4] }),
      expect.objectContaining({ object: post.id, name: 'Col', type: 'float3', channels: [`${folder}/post.fx:Col:x`, `${folder}/post.fx:Col:y`, `${folder}/post.fx:Col:z`], value: [0.5, 0.75, 1] }),
    ]);

    const shape = e.world.addShape(0, 0, 0, 0);
    await expect(run(e, 'mme_set_values', { object: shape.id, values: { X: 1 } })).rejects.toThrow('値 X はありません');
    await expect(run(e, 'mme_set_values', { object: post.id, values: { Nope: 1 } })).rejects.toThrow('値 Nope はありません');
    await expect(run(e, 'mme_set_values', { object: post.id, values: { X: 'a' } })).rejects.toThrow('値 X は数です');
    await expect(run(e, 'mme_set_values', { object: post.id, values: { X: 1, Nope: 1 } })).rejects.toThrow('値 Nope はありません');
    expect(e.world.find(post.id)?.mmeValues?.X).toBe(2); // (1 つでも壊れていれば、どれも変えない)
    await expect(run(e, 'mme_set_values', { object: post.id, values: {} })).rejects.toThrow('values に値を渡してください');
    await expect(run(e, 'mme_set_values', { object: 99, values: { X: 1 } })).rejects.toThrow('id 99 の物はありません');
    await expect(run(e, 'mme_set_values', { object: 'stage', values: { X: 1 } })).rejects.toThrow('ステージがありません');
  });

  it('mme_set_values: ステージのパラメータ (.fx を当てたステージ)', async () => {
    const e = new Engine();
    const folder = await fxFolder(e);
    const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(), [new THREE.MeshBasicMaterial()]);
    mesh.userData.sourceFile = new File([], 'sky.pmx');
    const stage = new THREE.Group();
    stage.add(mesh);
    e.stage.model = stage;
    e.graph.scene.add(stage);
    e.ui.set({ sceneVersion: e.ui.state.sceneVersion + 1 });
    await run(e, 'mme_assign', { object: 'stage', tab: 'Main', fx: { folder, path: 'post.fx' } });
    const r = await run(e, 'mme_set_values', { object: 'stage', values: { [`${folder}/post.fx:Strength`]: 2 } });
    expect(r).toEqual({ object: 'stage', values: { [`${folder}/post.fx:Strength`]: 2 } });
    expect(e.mme.saveScene().stageParams).toEqual({ [`${folder}/post.fx:Strength`]: 2 });
    expect((await run(e, 'mme_state')).params).toContainEqual(expect.objectContaining({ object: 'stage', name: 'Strength', value: [2] }));
  });

  it('insert_keyframe の channels: MME のチャンネルにキーを打つ (値のないチャンネルは既定の値を入れてから)。MME の物は channels なしで、値の全部に打つ', async () => {
    const e = new Engine();
    const folder = await fxFolder(e);
    const acc = await run(e, 'mme_add_accessory', { name: 'post.x', fx: { folder, path: 'post.fx' } });
    const obj = e.world.find(acc.id)!;
    await run(e, 'mme_set_values', { object: acc.id, values: { X: 5 } });
    const r = await run(e, 'insert_keyframe', { id: acc.id, frame: 12, channels: ['X', `${folder}/post.fx:Strength`] });
    expect(r).toEqual({ frame: 12, keyframes: [12] });
    expect([...obj.anim!.mme.keys()].map(i => obj.mmeChannels![i]).sort()).toEqual(['X', `${folder}/post.fx:Strength`].sort());
    expect(obj.mmeValues?.[`${folder}/post.fx:Strength`]).toBe(1); // (初期値)
    expect(obj.anim!.mme.get(obj.mmeChannels!.indexOf('X'))!.get(12)).toMatchObject({ v: 5 });
    await run(e, 'insert_keyframe', { id: acc.id, frame: 20 });
    expect((await run(e, 'get_state')).objects.find((o: { id: number }) => o.id === acc.id).kind).toBe('mme');
    expect(obj.anim!.mme.get(obj.mmeChannels!.indexOf('Tr'))!.has(20)).toBe(true);
    expect(e.clock.end).toBeGreaterThanOrEqual(20);
    await expect(run(e, 'insert_keyframe', { id: acc.id, channels: ['Nope'] })).rejects.toThrow('値 Nope はありません');
    await expect(run(e, 'insert_keyframe', { id: acc.id, channels: [] })).rejects.toThrow('channels に値の名前を渡してください');
    // コントローラーの項目も、モデルなどに当てた .fx のパラメータも
    const ctl = await run(e, 'mme_add_controller', { name: 'c.pmx' });
    await run(e, 'mme_set_values', { object: ctl.id, values: { 'SSAO+': 0.5 } });
    expect(await run(e, 'insert_keyframe', { id: ctl.id, frame: 3, channels: ['SSAO+'] })).toEqual({ frame: 3, keyframes: [3] });
  });

  it('mme_list_fx / mme_load_folder: fx/ のフォルダの一覧と、フォルダを読み込む (フォルダを選んだときと同じ)。サーバーがなければ分かるエラー', async () => {
    const e = new Engine();
    await expect(run(e, 'mme_list_fx')).rejects.toThrow('fx/ の一覧を取れません');
    await expect(run(e, 'mme_load_folder', { folder: 'ray' })).rejects.toThrow('fx/ の一覧を取れません');
    vi.mocked(listFxFolder).mockResolvedValue({ folders: [
      { name: 'ray', dir: 'ray', files: ['a.fx', 'tex.png', 'sub/b.fx'], fx: ['a.fx', 'sub/b.fx'], size: 2048, truncated: true },
      { name: 'other', dir: 'other', files: ['o.fx'], fx: ['o.fx'], size: 10 },
    ] });
    expect(await run(e, 'mme_list_fx')).toEqual({ folders: [
      { name: 'ray', fx: ['a.fx', 'sub/b.fx'], files: 3, bytes: 2048, truncated: true, loaded: false },
      { name: 'other', fx: ['o.fx'], files: 1, bytes: 10, loaded: false },
    ] });
    await expect(run(e, 'mme_load_folder', { folder: 'nope' })).rejects.toThrow('fx/ にフォルダ nope はありません (ray・other)');
    await expect(run(e, 'mme_load_folder', {})).rejects.toThrow('folder にフォルダの名前を渡してください');
    vi.mocked(fetchFxFiles).mockResolvedValue([fileAt('ray/a.fx', 'technique T { }'), fileAt('ray/sub/b.fx', 'technique T { }'), fileAt('ray/tex.png', 'x')]);
    const r = await run(e, 'mme_load_folder', { folder: 'RAY' });
    expect(r).toEqual({ folder: { id: expect.stringMatching(/^folder\d+$/), name: 'ray' }, fx: ['a.fx', 'sub/b.fx'], truncated: true });
    expect(e.mme.store.folders().map(f => f.name)).toEqual(['ray']);
    expect(e.ui.state.toast?.text).toBe('ray はファイルが多いか深すぎるので、一部だけ読み込みました');
    expect((await run(e, 'mme_state')).folders).toEqual([{ id: r.folder.id, name: 'ray', fx: ['a.fx', 'sub/b.fx'] }]);
    expect((await run(e, 'mme_list_fx')).folders[0].loaded).toBe(true);
    vi.mocked(fetchFxFiles).mockRejectedValue(new Error('a.fx'));
    await expect(run(e, 'mme_load_folder', { folder: 'other' })).rejects.toThrow('other を読み込めませんでした: a.fx');
  });

  it('mme_export_emm / mme_import_emm: 書き出して base64 で渡し、読み込むと同じ割り当てに戻る。壊れた引数はエラー', async () => {
    const e = new Engine();
    const folder = await fxFolder(e);
    const miku = model(e, 'miku.pmx');
    await run(e, 'mme_assign', { object: miku.id, tab: 'Main', fx: { folder, path: 'a.fx' } });
    await run(e, 'mme_assign', { object: miku.id, tab: 'Main', material: 1, fx: 'hide' });
    const { data } = await run(e, 'mme_export_emm');
    expect(typeof data).toBe('string');
    const g = new Engine();
    const gfolder = await fxFolder(g);
    const gmiku = model(g, 'miku.pmx');
    const r = await run(g, 'mme_import_emm', { data });
    expect(r).toEqual({ applied: 2, warnings: [] });
    expect(gmiku.mme).toEqual({ Main: { object: { folder: gfolder, path: 'a.fx' }, materials: { 1: 'hide' } } });
    // 場面にない物・.fx は警告で返る
    const lost = toBase64(encodeShiftJis('[Object]\r\nPmd1 = C:\\x\\absent.pmx\r\n[Effect]\r\nPmd1 = C:\\x\\a.fx\r\n'));
    expect((await run(g, 'mme_import_emm', { data: lost })).warnings).toEqual([expect.stringContaining('absent.pmx')]);
    await expect(run(g, 'mme_import_emm', {})).rejects.toThrow('data に .emm を base64 で渡してください');
    await expect(run(g, 'mme_import_emm', { data: '' })).rejects.toThrow('data に .emm を base64 で渡してください');
    expect(fromBase64(data).length).toBeGreaterThan(0);
  });

  it('open_project は、古いプロジェクトを開いたときの知らせ (notes) を返す', async () => {
    const json = JSON.parse(new TextDecoder().decode(await new Engine().project.save('reference')));
    json.mme.controls = { '   ': { Si: 0.5 } };
    const e = new Engine();
    const r = await run(e, 'open_project', { data: toBase64(new TextEncoder().encode(JSON.stringify(json))), name: 'old.wgpj' });
    expect(r.notes).toEqual([expect.stringContaining('名前が空')]);
    expect((await run(new Engine(), 'open_project', { data: toBase64(await new Engine().project.save('reference')) })).notes).toEqual([]);
  });
});
