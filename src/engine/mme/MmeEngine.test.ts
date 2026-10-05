import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeShiftJis } from '../../core/sjis';
import { Engine } from '../Engine';
import { kindOf } from '../types';
import { convertMmdMesh } from '../materials/fromMmd';
import { parseDefaultEffect } from '../../core/mme/defaultEffect.ts';
import { EffectInstance } from './EffectInstance';
import type { LoadedEffect } from './EffectStore';
import { readEmbedded } from '../project/format';
import { MME_DEFAULTS, normalizeMme } from './MmeEngine';
import type { DrawTarget } from './Framebuffers';
import { PostChain, type FrameState } from './PostChain';
import type { PassTable } from './ScenePass';

// フォルダから選んだファイル (webkitRelativePath は 'フォルダ/…')
function fileAt(path: string, text: string, lastModified?: number): File {
  const f = new File([text], path.slice(path.lastIndexOf('/') + 1), { lastModified });
  Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
}
// 読み込んだ .fx を指す割り当て
const ref = (e: LoadedEffect) => ({ folder: e.folder.id, path: e.entry });
// ポストエフェクトをオフにする (画面のオン・オフと同じく、アクセサリをビューポートでも書き出しでも隠す)
const OFF = { hidden: true, hideRender: true };

// 描画先なしで、レンダーエンジンの切り替えと Viewport.drawOverride の差し替えを確かめる
describe('MmeEngine', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('既定の設定', () => {
    expect(MME_DEFAULTS).toEqual({ engine: 'standard', selfShadow: true, shadowDistance: 8875, groundShadow: true });
    expect(new Engine().mme.settings).toEqual(MME_DEFAULTS);
  });

  it('setControl はその名前のコントローラーの物の値 (0〜1 に収める) とチャンネルを書き、描き直す。物の値なので元に戻せる。物がなければ何もしない', async () => {
    const e = new Engine();
    e.mme.setControl('ray_controller.pmx', 'SSAO+', 0.5);
    expect(e.world.objects).toEqual([]); // (勝手には置かない)
    const obj = e.addMmeObject({ kind: 'controller', name: 'ray_controller.pmx' });
    e.history.checkpoint();
    const draw = vi.spyOn(e.viewport, 'requestDraw');
    const edited = vi.spyOn(e.history, 'soon');
    const sceneEdited = vi.spyOn(e.autosave, 'schedule');
    e.mme.setControl('RAY_CONTROLLER.pmx', 'SSAO+', 3);
    expect(obj.mmeValues).toEqual({ 'SSAO+': 1 });
    expect(obj.mmeChannels).toEqual(['SSAO+']);
    expect(draw).toHaveBeenCalled();
    expect(edited).toHaveBeenCalled();
    expect(sceneEdited).not.toHaveBeenCalled(); // (自動保存は履歴の手から)
    e.mme.setControl('ray_controller.pmx', 'SSAO+', -1);
    e.mme.setControl('ray_controller.pmx', 'Bloom+', Number.NaN);
    expect(obj.mmeValues).toEqual({ 'SSAO+': 0, 'Bloom+': 0 });
    expect(obj.mmeChannels).toEqual(['SSAO+', 'Bloom+']);
    e.history.checkpoint();
    await e.history.undo();
    expect(obj.mmeValues).toBeUndefined();
    await e.history.redo();
    expect(obj.mmeValues).toEqual({ 'SSAO+': 0, 'Bloom+': 0 });
  });

  const ctl = (item: string) => ({ param: 'p', name: 'ray_controller.pmx', item, type: 'float' as const });

  it('CONTROLOBJECT はコントローラーの物の値を読む。同じ名前の物が 2 つなら場面の並びで最初の物', () => {
    const e = new Engine();
    const a = e.addMmeObject({ kind: 'controller', name: 'ray_controller.pmx' });
    const b = e.addMmeObject({ kind: 'controller', name: 'ray_controller.pmx' });
    b.mmeValues = { 'SSAO+': 1 };
    expect(e.mme.controllers.value(ctl('SSAO+'), null, null)).toEqual([0]);
    e.mme.setControl('ray_controller.pmx', 'SSAO+', 0.5);
    expect([a.mmeValues, b.mmeValues]).toEqual([{ 'SSAO+': 0.5 }, { 'SSAO+': 1 }]);
    expect(e.mme.controllers.value(ctl('SSAO+'), null, null)).toEqual([0.5]);
    e.setOrder([b.id, a.id]);
    expect(e.mme.controllers.value(ctl('SSAO+'), null, null)).toEqual([1]);
  });

  it('コントローラーの物のキーフレームで、CONTROLOBJECT の値と画面の値がフレームごとに変わる (描き直す)', async () => {
    const e = new Engine();
    const box = e.world.addShape(0, 0, 0, 0);
    const fx = await e.mme.loadEffect([fileAt('Fx/ctl.fx', 'float m : CONTROLOBJECT < string name = "ray_controller.pmx"; string item = "SSAO+"; >;\ntechnique T { }')], 'ctl.fx');
    e.mme.assign(box, 'Main', null, ref(fx));
    const obj = e.addMmeObject({ kind: 'controller', name: 'ray_controller.pmx' });
    e.mme.setControl('ray_controller.pmx', 'SSAO+', 0);
    e.keyframes.insertMme(obj, 0, ['SSAO+']);
    e.mme.setControl('ray_controller.pmx', 'SSAO+', 1);
    e.keyframes.insertMme(obj, 30, ['SSAO+']);
    const draw = vi.spyOn(e.viewport, 'requestDraw');
    e.keyframes.applyAll(0, true); // (0 フレーム)
    expect(e.mme.controllers.value(ctl('SSAO+'), null, null)).toEqual([0]);
    expect(e.ui.state.mme.values?.items).toEqual([{ name: 'SSAO+', value: 0 }]); // (選んでいるコントローラーの物の値の欄)
    draw.mockClear();
    e.keyframes.applyAll(1, true); // (30 フレーム = 1 秒)
    expect(e.mme.controllers.value(ctl('SSAO+'), null, null)).toEqual([1]);
    expect(e.ui.state.mme.values?.items).toEqual([{ name: 'SSAO+', value: 1 }]);
    expect(draw).toHaveBeenCalled();
  });

  it('missingControllers: 描いているエフェクトが読む仮のコントローラーのうち、場面に物がない名前と項目', async () => {
    const e = new Engine();
    const box = e.world.addShape(0, 0, 0, 0);
    const decl = (v: string, name: string, item: string) => `float ${v} : CONTROLOBJECT < string name = "${name}"; string item = "${item}"; >;`;
    const fx = await e.mme.loadEffect([fileAt('Fx/ctl.fx', `${decl('a', 'ray_controller.pmx', 'SSAO+')}\n${decl('b', 'ray_controller.pmx', 'Bloom+')}\n${decl('c', 'other.pmx', 'On')}\ntechnique T { }`)], 'ctl.fx');
    expect(e.mme.missingControllers()).toEqual([]);
    e.mme.assign(box, 'Main', null, ref(fx));
    expect(e.mme.missingControllers()).toEqual([{ name: 'other.pmx', items: ['On'] }, { name: 'ray_controller.pmx', items: ['Bloom+', 'SSAO+'] }]);
    // (画面の一覧は場面にない名前も (「置く」の元)。名前の順)
    expect(e.ui.state.mme.controllers).toEqual([{ name: 'other.pmx', items: ['On'], objId: null }, { name: 'ray_controller.pmx', items: ['Bloom+', 'SSAO+'], objId: null }]);
    const obj = e.addMmeObject({ kind: 'controller', name: 'Ray_Controller.pmx' });
    expect(e.mme.missingControllers()).toEqual([{ name: 'other.pmx', items: ['On'] }]);
    expect(e.ui.state.mme.controllers).toEqual([{ name: 'other.pmx', items: ['On'], objId: null }, { name: 'ray_controller.pmx', items: ['Bloom+', 'SSAO+'], objId: obj.id }]);
    // (置いた物を選んでいるので、値の欄はその物の項目。値がなければ 0)
    expect(e.ui.state.mme.values).toEqual({ objId: obj.id, kind: 'controller', items: [{ name: 'Bloom+', value: 0 }, { name: 'SSAO+', value: 0 }], effects: [] });
  });

  it('engine を mme にすると drawOverride が MME の描画を呼び、standard に戻すと前の描画に戻る', () => {
    const e = new Engine();
    // 前の描画 (効果の後処理)
    const prev = vi.spyOn(e.effects as unknown as { render: () => boolean }, 'render').mockReturnValue(false);
    const render = vi.spyOn(e.mme.renderer, 'render').mockReturnValue(true);
    const dispose = vi.spyOn(e.mme.renderer, 'dispose');
    const draw = vi.spyOn(e.viewport, 'requestDraw');

    expect(e.viewport.drawOverride!()).toBe(false);
    expect([prev.mock.calls.length, render.mock.calls.length]).toEqual([1, 0]);

    e.mme.set({ engine: 'mme' });
    expect(draw).toHaveBeenCalled();
    expect(e.viewport.drawOverride!()).toBe(true);
    expect([prev.mock.calls.length, render.mock.calls.length]).toEqual([1, 1]);
    expect(dispose).not.toHaveBeenCalled();

    e.mme.set({ engine: 'standard' });
    expect(dispose).toHaveBeenCalledTimes(1); // 資源を片付ける
    expect(e.viewport.drawOverride!()).toBe(false);
    expect([prev.mock.calls.length, render.mock.calls.length]).toEqual([2, 1]);
  });

  it('render が例外を出したら標準のエンジン (前の描画) で描き、お知らせを 1 回だけ出す', () => {
    const e = new Engine();
    e.mme.set({ engine: 'mme' });
    const prev = vi.spyOn(e.effects as unknown as { render: () => boolean }, 'render').mockReturnValue(true);
    vi.spyOn(e.mme.renderer, 'render').mockImplementation(() => { throw new Error('壊れた'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const toast = vi.spyOn(e.ui, 'toast');
    expect(e.viewport.drawOverride!()).toBe(true); // (前の描画の結果)
    expect(e.viewport.drawOverride!()).toBe(true);
    expect(prev).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1); // (同じ例外が続くあいだ、コンソールにも 1 回)
    expect(toast).toHaveBeenCalledTimes(1);
    expect(e.ui.state.toast?.text).toContain('壊れた');
    // 違う例外は書く。一度描けたら、同じ例外もまた書く (お知らせは同じ文なら 1 回のまま)
    const render = vi.spyOn(e.mme.renderer, 'render').mockImplementation(() => { throw new Error('別の壊れ方'); });
    e.viewport.drawOverride!();
    expect(error).toHaveBeenCalledTimes(2);
    render.mockReturnValueOnce(true);
    e.viewport.drawOverride!();
    render.mockImplementation(() => { throw new Error('別の壊れ方'); });
    e.viewport.drawOverride!();
    expect(error).toHaveBeenCalledTimes(3);
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it('割り当てた物を消しても例外にならず、ほかの物の割り当てはそのまま', async () => {
    const e = new Engine();
    const a = e.world.addShape(0, 0, 0, 0), b = e.world.addShape(0, 3, 0, 1);
    const fx = await e.mme.loadEffect([fileAt('Fx/a.fx', 'technique T { }')], 'a.fx');
    e.mme.assign(a, 'Main', null, ref(fx));
    e.mme.assign(b, 'Main', 0, ref(fx));
    const r = e.mme.renderer as unknown as Internals;
    const dispose = vi.spyOn(r.instance(fx) as unknown as EffectInstance, 'dispose');
    expect(() => e.world.remove(a)).not.toThrow();
    expect(dispose).not.toHaveBeenCalled(); // (b が使っている)
    expect(r.mainSlot(b, b.mesh!, 0)).toEqual({ kind: 'effect', effect: fx, assigned: true });
    expect(b.mme).toEqual({ Main: { materials: { 0: ref(fx) } } });
    e.world.remove(b);
    expect(dispose).toHaveBeenCalledTimes(1); // (もうどの物も使っていない)
  });

  it('割り当ては物の値 mme: 画面から変えると元に戻すの手になり、元に戻す・やり直す・複製で写る。null は既定に戻す', async () => {
    const e = new Engine();
    const obj = e.world.addShape(0, 0, 0, 0);
    e.history.checkpoint();
    const fx = await e.mme.loadEffect([fileAt('Fx/a.fx', 'technique T { }')], 'a.fx');
    const soon = vi.spyOn(e.history, 'soon');
    e.mme.assign(obj, 'Main', 1, ref(fx));
    expect(soon).toHaveBeenCalled();
    const assigned = { Main: { materials: { 1: ref(fx) } } };
    expect(obj.mme).toEqual(assigned);
    await e.history.undo();
    expect(obj.mme).toBeUndefined();
    expect(e.ui.state.toast?.text).toContain('MME のエフェクト');
    await e.history.redo();
    expect(obj.mme).toEqual(assigned);
    e.selection.select(obj);
    const copy = await e.duplicateSelected();
    expect(copy?.mme).toEqual(assigned);
    expect(copy?.mme).not.toBe(obj.mme);
    e.mme.assign(obj, 'Main', null, 'hide');
    expect(obj.mme).toEqual({ Main: { object: 'hide', materials: { 1: ref(fx) } } });
    e.mme.assign(obj, 'Main', 1, null);
    e.mme.assign(obj, 'Main', null, null);
    expect(obj.mme).toBeUndefined();
  });

  it('whenReady は .fx のテクスチャと .pmx の読み込みを待つ (何もなければすぐ終わる)', async () => {
    const e = new Engine();
    e.world.addShape(0, 0, 0, 0);
    await expect(e.mme.whenReady()).resolves.toBeUndefined();
  });

  // 描画先なしで、描く物の集め方と値を見る (private を呼ぶ)
  type Internals = {
    scenePass: {
      collect(frame: { frameNo: number }): { mesh: THREE.Mesh }[];
      toonOf(src: THREE.Texture): { tex: THREE.DataTexture } | null;
    };
    frame(renderer: unknown): { selfShadow: boolean };
    shadow: THREE.WebGLRenderTarget | null;
    mainSlot(obj: unknown, mesh: THREE.Mesh, materialIndex: number): unknown;
    mainSlots: Map<unknown, unknown>;
    instance(e: unknown): { stopped: boolean };
    light(): { shadowProjection: THREE.Matrix4 };
    warnFor(e: unknown, message: string): void;
    instances: Map<unknown, unknown>;
  };

  it('ステージを先に (背景として) 描き、それから置いた物を置いた順に描く', () => {
    const e = new Engine();
    const a = e.world.addShape(0, 0, 0, 0), b = e.world.addShape(0, 3, 0, 1);
    const stage = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    e.stage.model = stage;
    e.graph.scene.add(stage);
    const items = (e.mme.renderer as unknown as Internals).scenePass.collect({ frameNo: 1 });
    expect(items.map(i => i.mesh)).toEqual([stage, a.mesh, b.mesh]);
  });

  it('GPU で止めたエフェクトを当てた物は default.fx で描く', async () => {
    const e = new Engine();
    const obj = e.world.addShape(0, 0, 0, 0);
    const fx = await e.mme.loadEffect([new File(['technique T { }'], 'a.fx')], 'a.fx');
    e.mme.assign(obj, 'Main', null, ref(fx));
    const r = e.mme.renderer as unknown as Internals;
    expect(r.mainSlot(obj, obj.mesh!, 0)).toEqual({ kind: 'effect', effect: fx, assigned: true });
    r.instance(fx).stopped = true;
    // (そのフレームのうちは変えない。次のフレームから default.fx)
    expect(r.mainSlot(obj, obj.mesh!, 0)).toEqual({ kind: 'effect', effect: fx, assigned: true });
    r.mainSlots.clear();
    expect(r.mainSlot(obj, obj.mesh!, 0)).toEqual({ kind: 'effect', effect: e.mme.store.defaultEffect });
    expect(e.mme.renderer.stopped(fx)).toBe(true);
  });

  it('ポストエフェクトの資源は、一覧にあるあいだ捨てず (オフでも)、外すと捨てる。whenReady はオンのポストエフェクトのテクスチャも待つ', async () => {
    const e = new Engine();
    const fx = await e.mme.loadEffect([new File(['technique T { }'], 'post.fx')], 'post.fx');
    const r = e.mme.renderer as unknown as Internals;
    const ready = vi.spyOn(EffectInstance.prototype, 'ready');
    const acc = e.mme.addPost(fx)!;
    await e.mme.whenReady();
    const inst = r.instance(fx);
    expect(ready.mock.contexts).toContain(inst);
    const dispose = vi.spyOn(inst as unknown as EffectInstance, 'dispose');
    e.setVisibility(acc, OFF); // (オフ = アクセサリを隠す)
    e.mme.renderer.prune();
    expect(dispose).not.toHaveBeenCalled();
    e.world.remove(acc); // (外す = アクセサリを消す。removed で prune される)
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  // --- ポストエフェクト = アクセサリの物に当てた .fx (設計書「仮のアクセサリ」) ---
  it('ポストエフェクトは、場面の並びのアクセサリの物のうち Main の物の割り当てが .fx のもの (同じ名前でも両方)。隠すと飛ばし (書き出しのときは書き出しで隠すもの)、並べ替えで順が変わる', async () => {
    const e = new Engine();
    const a = await e.mme.loadEffect([fileAt('P/a.fx', 'technique A { }'), fileAt('P/b.fx', 'technique B { }')], 'a.fx');
    const b = e.mme.store.effect(a.folder, 'b.fx');
    const x = e.mmeObjects.add({ kind: 'accessory', name: 'post.x' });
    const shape = e.world.addShape(0, 0, 0, 0);
    const y = e.mmeObjects.add({ kind: 'accessory', name: 'post.x' });
    const plain = e.mmeObjects.add({ kind: 'accessory', name: 'plain.x' }); // (割り当てなし)
    const hidden = e.mmeObjects.add({ kind: 'accessory', name: 'hide.x' }); // (hide)
    const ctl = e.mmeObjects.add({ kind: 'controller', name: 'ctl.pmx' }); // (コントローラーはポストエフェクトにしない)
    const offscreen = e.mmeObjects.add({ kind: 'accessory', name: 'off.x' }); // (オフスクリーンのタブだけ)
    for (const o of [x, shape, ctl]) e.mme.assign(o, 'Main', null, ref(a));
    e.mme.assign(y, 'Main', null, ref(b));
    e.mme.assign(hidden, 'Main', null, 'hide');
    e.mme.assign(offscreen, 'OffMap', null, ref(a));
    expect(plain.mme).toBeUndefined();
    expect(e.mme.posts()).toEqual([{ obj: x, effect: a }, { obj: y, effect: b }]);
    e.setVisibility(x, { hidden: true });
    expect(e.mme.posts()).toEqual([{ obj: y, effect: b }]);
    expect(e.mme.posts(true)).toEqual([{ obj: x, effect: a }, { obj: y, effect: b }]);
    // コレクションで隠しても飛ばす
    e.setVisibility(x, { hidden: false });
    e.moveToCollection('C', [y]);
    e.setCollectionHidden('C', true);
    expect(e.mme.posts()).toEqual([{ obj: x, effect: a }]);
    e.setCollectionHidden('C', false);
    // 書き出しのあいだは、書き出しで隠すもの (ビューポートで隠したものは描く)
    e.setVisibility(x, { hidden: true });
    e.setVisibility(y, { hideRender: true });
    const outputting = vi.spyOn(e.viewport, 'outputting', 'get').mockReturnValue(true);
    expect(e.mme.posts()).toEqual([{ obj: x, effect: a }]);
    outputting.mockRestore();
    e.setVisibility(x, { hidden: false });
    e.setVisibility(y, { hideRender: false });
    // 並べ替え (アウトライナー・reorder_objects と同じ物の並び)
    e.moveObject(y, x, 'before');
    expect(e.mme.posts()).toEqual([{ obj: y, effect: b }, { obj: x, effect: a }]);
    // 描いている .fx (仮のコントローラーの欄の元) は、隠していないポストエフェクトのもの
    e.setVisibility(y, { hidden: true });
    expect(e.mme.renderer.drawnEffects()).not.toContain(b);
    expect(e.mme.renderer.drawnEffects()).toContain(a);
  });

  it('書き出しの前の whenReady は、書き出しで隠していないポストエフェクトを待つ (書き出しの前で outputting でなくても、ビューポートだけで隠したものは待ち、書き出しで隠したものは待たない)', async () => {
    const e = new Engine();
    const fx = await e.mme.loadEffect([fileAt('P/a.fx', 'technique A { }'), fileAt('P/b.fx', 'technique B { }')], 'a.fx');
    const viewOnly = e.mme.addPost(fx)!, renderOff = e.mme.addPost(e.mme.store.effect(fx.folder, 'b.fx'))!;
    e.setVisibility(viewOnly, { hidden: true });
    e.setVisibility(renderOff, { hideRender: true });
    const [a, b] = e.mme.posts(true).map(p => p.effect);
    expect(e.viewport.outputting).toBe(false);
    const ready = vi.spyOn(EffectInstance.prototype, 'ready');
    await e.mme.whenReady();
    const r = e.mme.renderer as unknown as Internals;
    const waited = [...r.instances].filter(([, inst]) => ready.mock.contexts.includes(inst as unknown as EffectInstance)).map(([x]) => x);
    expect(waited).toContain(a);
    expect(waited).not.toContain(b);
  });

  it('addPostEffect は .fx を読んで、アクセサリの物 (名前は .fx のファイル名の拡張子を .x にしたもの) を場面の最後に置いて Main に当てる。選んでいる物は変えない。1 回の取り消しで消え、置けなければ知らせる', async () => {
    const e = new Engine();
    const box = e.world.addShape(0, 0, 0, 0);
    e.selection.select(box);
    e.history.checkpoint();
    const acc = await e.mme.addPostEffect([fileAt('Ray/Main/ray.FX', 'technique T { }')], 'Main/ray.FX');
    expect(e.world.objects).toEqual([box, acc]);
    expect(acc?.mmeObj).toEqual({ kind: 'accessory', name: 'ray.x' });
    expect(acc?.mmeValues).toEqual({ X: 0, Y: 0, Z: 0, Rx: 0, Ry: 0, Rz: 0, Si: 1, Tr: 1 });
    expect(acc?.mme).toEqual({ Main: { object: { folder: e.mme.store.folders()[0].id, path: 'Main/ray.FX' } } });
    expect(e.mme.posts().map(p => p.obj)).toEqual([acc]);
    expect(e.selection.current).toBe(box);
    e.history.checkpoint();
    await e.history.undo();
    expect(e.world.objects).toEqual([box]);
    expect(e.mme.posts()).toEqual([]);
    await e.history.redo();
    expect(e.mme.posts().map(p => p.obj.mme)).toEqual([acc?.mme]);
    // 置ける数を超えるときは、知らせて置かない (当てない)
    vi.spyOn(e.world, 'full', 'get').mockReturnValue(true);
    e.ui.hideToast();
    expect(await e.mme.addPostEffect([fileAt('Ray/Main/ray.FX', 'technique T { }')], 'Main/ray.FX')).toBeNull();
    expect(e.ui.state.toast?.text).toBe('これ以上置けません');
    expect(e.world.objects).toHaveLength(2);
  });

  it('ポストエフェクトの (self) はそのアクセサリ: CONTROLOBJECT の Si はアクセサリの値 (同じ名前のアクセサリが 2 つでも、それぞれのもの)', async () => {
    const e = new Engine();
    const fx = await e.mme.loadEffect([fileAt('P/si.fx', 'float s : CONTROLOBJECT < string name = "(self)"; string item = "Si"; >;\ntechnique T { }')], 'si.fx');
    const first = e.mme.addPost(fx)!, second = e.mme.addPost(fx)!;
    second.mmeValues!.Si = 0.5;
    const si = { param: 's', name: '(self)', item: 'Si', type: 'float' as const };
    expect(e.mme.posts().map(p => p.obj)).toEqual([first, second]);
    expect(e.mme.posts().map(p => e.mme.controllers.value(si, p.obj, null))).toEqual([[1], [0.5]]);
    // 名前で引くと、場面の並びで最初のもの
    expect(e.mme.controllers.value({ ...si, name: 'si.x' }, null, null)).toEqual([1]);
    // .x の名前は仮のコントローラーにしない (「置く」の一覧に出さない)
    e.mme.set({ engine: 'mme' });
    const box = e.world.addShape(0, 0, 0, 0);
    const reader = await e.mme.loadEffect([fileAt('P/reader.fx', 'float a : CONTROLOBJECT < string name = "missing.x"; string item = "Si"; >;\nfloat b : CONTROLOBJECT < string name = "missing.pmx"; string item = "On"; >;\ntechnique T { }')], 'reader.fx');
    e.mme.assign(box, 'Main', null, ref(reader));
    expect(e.mme.missingControllers()).toEqual([{ name: 'missing.pmx', items: ['On'] }]);
  });

  it('第 4 の計画の形の mme (場面の値 posts) のプロジェクトを開くと、並びとオン・オフのまま、アクセサリの物を作って当てる (開いた状態の一部で、元に戻す手にしない。保存するときは posts を書かない)', async () => {
    const e = new Engine();
    e.world.addShape(0, 0, 0, 0);
    const a = await e.mme.loadEffect([fileAt('Fx/a.fx', 'technique A { }'), fileAt('Fx/sub/b.fx', 'technique B { }')], 'a.fx');
    e.mme.store.effect(a.folder, 'sub/b.fx'); // (読んだファイルにして、保存させる)
    const id = a.folder.id;
    const json = JSON.parse(new TextDecoder().decode(await e.project.save('reference')));
    expect('posts' in json.mme).toBe(false);
    json.mme.posts = [
      { effect: { folder: id, path: 'a.fx' }, enabled: true },
      { effect: { folder: id, path: 'sub/b.fx' }, enabled: false },
      { effect: { folder: 'folder99', path: 'gone.fx' }, enabled: true }, // (フォルダがない: 描いていなかったので移さない)
    ];
    // (同じページで開く: フォルダのファイルは、このページで読んだもの)
    const f = e;
    e.ui.hideToast();
    await f.project.open(new TextEncoder().encode(JSON.stringify(json)));
    const accessories = f.world.objects.filter(o => o.mmeObj);
    // (オフはビューポートでも書き出しでも隠す: 書き出しも同じ絵)
    expect(accessories.map(o => [o.mmeObj, o.mme, !!o.hidden, !!o.hideRender, o.mmeValues?.Si])).toEqual([
      [{ kind: 'accessory', name: 'a.x' }, { Main: { object: { folder: id, path: 'a.fx' } } }, false, false, 1],
      [{ kind: 'accessory', name: 'b.x' }, { Main: { object: { folder: id, path: 'sub/b.fx' } } }, true, true, 1],
    ]);
    expect(f.mme.posts().map(p => [p.obj.mmeObj?.name, p.effect.entry, p.effect.result.ok])).toEqual([['a.x', 'a.fx', true]]);
    expect(f.mme.posts(true).map(p => p.effect.entry)).toEqual(['a.fx', 'sub/b.fx']);
    expect(f.history.canUndo).toBe(false);
    expect(f.ui.state.toast).toBeNull();
    expect('posts' in f.mme.saveScene()).toBe(false);
  });

  it('古い posts を移せなかった (置ける数を超えた) ことは、開いたお知らせに名前をまとめて添える', async () => {
    const json = JSON.parse(new TextDecoder().decode(await new Engine().project.save('reference')));
    json.mme.folders = [{ id: 'folder1', name: 'Fx' }]; // (ファイルのないフォルダ)
    json.mme.posts = [{ effect: { folder: 'folder1', path: 'a.fx' }, enabled: true }, { effect: { folder: 'folder1', path: 'b.fx' }, enabled: false }];
    const f = new Engine();
    const full = vi.spyOn(f.world, 'full', 'get').mockReturnValue(true);
    await f.project.openFile(new File([JSON.stringify(json)], 'old.wgpj'));
    full.mockRestore();
    expect(f.world.objects).toEqual([]);
    expect(f.ui.state.toast?.text).toBe('old.wgpj を開きました (古いプロジェクトのポストエフェクト a.x・b.x をアクセサリに移せませんでした (これ以上置けません))');
  });

  it('同じ名前のフォルダを読み直してファイルが変わると、そのフォルダのポストエフェクトは新しい中身でコンパイルしたものになる (並び・オン・オフはそのまま。ほかのフォルダのものは同じ)', async () => {
    const e = new Engine();
    const a = await e.mme.loadEffect([fileAt('A/a.fx', 'technique Old { }', 1)], 'a.fx');
    const b = await e.mme.loadEffect([fileAt('B/b.fx', 'technique B { }')], 'b.fx');
    e.mme.addPost(b);
    e.setVisibility(e.mme.addPost(a)!, OFF);
    await e.mme.loadEffect([fileAt('A/a.fx', 'technique New { }', 2)], 'a.fx');
    const [first, second] = e.mme.posts(true);
    expect(first.effect).toBe(b);
    expect(second.obj.hidden).toBe(true);
    expect(second.effect).not.toBe(a);
    expect(second.effect.result.ok && second.effect.result.effect.techniques[0].name).toBe('New');
    // (変わらなければ、そのまま)
    await e.mme.loadEffect([fileAt('A/a.fx', 'technique New { }', 2)], 'a.fx');
    expect(e.mme.posts(true)[1].effect).toBe(second.effect);
  });

  it('セルフシャドウを切ると深度マップを捨てる', () => {
    const e = new Engine();
    const r = e.mme.renderer as unknown as Internals;
    const target = new THREE.WebGLRenderTarget(4, 4);
    const dispose = vi.spyOn(target, 'dispose');
    r.shadow = target;
    const renderer = { getDrawingBufferSize: (v: THREE.Vector2) => v.set(320, 240), extensions: { has: () => true } };
    expect(r.frame(renderer).selfShadow).toBe(true); // (あるものを使う)
    expect(dispose).not.toHaveBeenCalled();
    e.mme.set({ selfShadow: false });
    expect(r.frame(renderer).selfShadow).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(r.shadow).toBeNull();
  });

  it('場面にないモデルのトゥーンの画像は prune と物を消したときに捨てる', () => {
    const e = new Engine();
    const r = e.mme.renderer as unknown as Internals;
    const toonImage = () => {
      const t = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(200), 4, 4);
      t.needsUpdate = true;
      return t;
    };
    // 置いた物の材質が使うトゥーン (MMD の材質を変換したもの) と、どこにもないトゥーン
    const used = toonImage(), orphan = toonImage();
    const mat = new THREE.MeshPhongMaterial();
    Object.assign(mat, { gradientMap: used });
    mat.userData.outlineParameters = { visible: false, thickness: 0, color: [0, 0, 0], alpha: 1 };
    const fake = { name: 'm', material: mat, userData: {} } as unknown as THREE.Mesh;
    convertMmdMesh(fake, e.library);
    const obj = e.world.addShape(0, 0, 0, 0);
    obj.mesh!.material = fake.material;
    const kept = r.scenePass.toonOf(used)!.tex, dropped = r.scenePass.toonOf(orphan)!.tex;
    const disposed = { kept: vi.fn(), dropped: vi.fn() };
    kept.addEventListener('dispose', disposed.kept);
    dropped.addEventListener('dispose', disposed.dropped);
    e.mme.renderer.prune();
    expect(disposed.dropped).toHaveBeenCalledTimes(1);
    expect(disposed.kept).not.toHaveBeenCalled();
    expect(r.scenePass.toonOf(used)!.tex).toBe(kept); // (使っているものは作り直さない)
    e.world.remove(obj);
    expect(disposed.kept).toHaveBeenCalledTimes(1);
  });

  it('影の距離が 0 でも 9999 でもセルフシャドウの射影は有限', () => {
    const e = new Engine();
    for (const shadowDistance of [0, 9999]) {
      e.mme.set({ shadowDistance });
      const p = (e.mme.renderer as unknown as Internals).light().shadowProjection;
      expect(p.elements.every(Number.isFinite)).toBe(true);
    }
  });

  it('影の距離は MMD と同じく、大きいほど範囲が狭い (範囲は (10000 − 値) に比例。8875 が標準のエンジンの太陽の影と同じ)', () => {
    const e = new Engine();
    // 正射影の x の倍率 (範囲の幅に反比例)
    const scaleX = (shadowDistance: number) => {
      e.mme.set({ shadowDistance });
      return (e.mme.renderer as unknown as Internals).light().shadowProjection.elements[0];
    };
    const base = scaleX(8875);
    expect(scaleX(9999) / base).toBeCloseTo(1125, 6); // 幅は 1 / 1125
    expect(scaleX(0) / base).toBeCloseTo(1125 / 10000, 9); // 幅は 10000 / 1125 倍
    expect(scaleX(5000) / base).toBeCloseTo(1125 / 5000, 9);
  });

  it('レンダーエンジンの設定をプロジェクトの場面の値として保存し、開き直すと戻る', async () => {
    const e = new Engine();
    const saved = { engine: 'mme', selfShadow: false, shadowDistance: 1200, groundShadow: false } as const;
    e.mme.set(saved);
    const bytes = await e.project.save('reference');
    const f = new Engine();
    await f.project.open(bytes);
    expect(f.mme.settings).toEqual(saved);
    expect(f.ui.state.mme.settings).toEqual(saved);
    // 最初の状態に戻すと既定
    f.resetAll();
    expect(f.mme.settings).toEqual(MME_DEFAULTS);
    expect(f.ui.state.mme.settings).toEqual(MME_DEFAULTS);
    // 前のプロジェクト (mme がない) は既定
    const g = new Engine();
    g.mme.set(saved);
    await g.project.open(await f.project.save('reference').then(b => {
      const json = JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;
      expect(json.mme).toMatchObject({ settings: MME_DEFAULTS }); // (MmeScene の settings)
      delete json.mme;
      return new TextEncoder().encode(JSON.stringify(json));
    }));
    expect(g.mme.settings).toEqual(MME_DEFAULTS);
  });

  it('normalizeMme: 知らない値は既定、影の距離は 0〜9999', () => {
    for (const raw of [undefined, null, 'mme', 3, []]) expect(normalizeMme(raw)).toEqual(MME_DEFAULTS);
    expect(normalizeMme({ engine: 'mme', selfShadow: false, shadowDistance: 100, groundShadow: false }))
      .toEqual({ engine: 'mme', selfShadow: false, shadowDistance: 100, groundShadow: false });
    expect(normalizeMme({ engine: 'dx11', selfShadow: 'yes', shadowDistance: 'far', groundShadow: 1 })).toEqual(MME_DEFAULTS);
    expect(normalizeMme({ shadowDistance: -5 }).shadowDistance).toBe(0);
    expect(normalizeMme({ shadowDistance: 1e6 }).shadowDistance).toBe(9999);
    expect(normalizeMme({ shadowDistance: Number.NaN }).shadowDistance).toBe(MME_DEFAULTS.shadowDistance);
    expect(normalizeMme({ shadowDistance: Infinity }).shadowDistance).toBe(MME_DEFAULTS.shadowDistance);
    expect(normalizeMme(undefined)).not.toBe(MME_DEFAULTS); // (写しを返す)
  });

  it('MME 互換 → 標準 → MME 互換と行き来しても、標準に戻したときに MME の資源を片付ける', async () => {
    const e = new Engine();
    const fx = await e.mme.loadEffect([new File(['technique T { }'], 'post.fx')], 'post.fx');
    e.mme.addPost(fx);
    const r = e.mme.renderer as unknown as Internals;
    const standard = await e.project.save('reference'); // (標準のエンジンのプロジェクト)
    for (let round = 0; round < 2; round++) {
      e.mme.set({ engine: 'mme' });
      const inst = r.instance(fx) as unknown as EffectInstance; // (描くときに作る資源)
      const dispose = vi.spyOn(inst, 'dispose');
      const skinner = vi.spyOn(e.mme.renderer.skinner, 'dispose');
      e.mme.set({ selfShadow: round === 0 }); // MME 互換のまま設定を変えても捨てない
      expect(dispose).not.toHaveBeenCalled();
      e.mme.set({ engine: 'standard' });
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(skinner).toHaveBeenCalledTimes(1);
      e.mme.set({ engine: 'standard' }); // (標準のままなら何もしない)
      expect(dispose).toHaveBeenCalledTimes(1);
    }
    // 標準のエンジンのプロジェクトを開いても片付ける
    e.mme.set({ engine: 'mme' });
    const inst = r.instance(fx) as unknown as EffectInstance;
    const dispose = vi.spyOn(inst, 'dispose');
    await e.project.open(standard);
    expect(e.mme.settings.engine).toBe('standard');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('画面に、設定・選んでいる物の .fx・ポストエフェクトの一覧とコンパイルの結果・描くときの警告を出す', async () => {
    const e = new Engine();
    expect(e.ui.state.mme).toEqual({ settings: MME_DEFAULTS, object: null, posts: [], warnings: [], folders: [], tabs: [{ name: 'Main', description: '' }], rows: { Main: [] }, controllers: [], values: null });
    e.mme.set({ engine: 'mme' });
    expect(e.ui.state.mme.settings.engine).toBe('mme');
    const obj = e.world.addShape(0, 0, 0, 0);
    e.selection.select(obj);
    // (同じフォルダに読み足すとフォルダの .fx はコンパイルし直すので、まとめて読む)
    const good = await e.mme.loadEffect([fileAt('Fx/good.fx', 'technique T { }'), fileAt('Fx/bad.fx', 'float4 x = ;')], 'good.fx');
    const bad = e.mme.store.effect(good.folder, 'bad.fx');
    e.mme.assign(obj, 'Main', null, ref(bad));
    const object = e.ui.state.mme.object!;
    expect(object).toMatchObject({ name: 'Fx/bad.fx', ok: false, warnings: [] });
    expect(object.errors.length).toBeGreaterThan(0);
    expect(object.errors[0]).toEqual({ code: expect.stringMatching(/^FX-/), where: 'bad.fx:1', message: expect.any(String) });
    e.selection.select(null);
    expect(e.ui.state.mme.object).toBeNull();
    e.selection.select(obj);
    e.mme.assign(obj, 'Main', null, null);
    expect(e.ui.state.mme.object).toBeNull();

    const acc = e.mme.addPost(good)!;
    e.setVisibility(acc, OFF);
    e.mme.publish();
    expect(e.ui.state.mme.posts).toEqual([{ id: good.id, name: 'Fx/good.fx', ok: true, errors: [], errorCount: 0, warnings: [], enabled: false, objId: acc.id, accessory: 'good.x' }]);
    // 描いたときの警告: エフェクトの警告はその行に、ほかは全体の警告に
    const r = e.mme.renderer as unknown as Internals;
    vi.spyOn(e.mme.renderer, 'render').mockImplementation(() => {
      (r.instance(good) as unknown as EffectInstance).warn('テクスチャ a.png が見つかりません');
      if (!e.mme.renderer.warnings.length) e.mme.renderer.warnings.push('全体の警告');
      return true;
    });
    e.viewport.drawOverride!();
    expect(e.ui.state.mme.posts[0].warnings).toEqual(['テクスチャ a.png が見つかりません']);
    expect(e.ui.state.mme.warnings).toEqual(['全体の警告']);
    // GPU で止めたら、その行に書く
    (r.instance(good) as unknown as EffectInstance).stopped = true;
    e.viewport.drawOverride!();
    expect(e.ui.state.mme.posts[0].warnings).toEqual(['テクスチャ a.png が見つかりません', 'GPU で使えないので止めました']);
    // 標準に戻すと警告も捨てる (MME 互換に戻して描き直すと、また集める)
    e.mme.set({ engine: 'standard' });
    expect(e.ui.state.mme.warnings).toEqual([]);
    expect(e.ui.state.mme.posts[0].warnings).toEqual([]);
  });

  it('選んでいる物に割り当てた .fx がフォルダにないときは、画面の物の .fx を空にし、コンパイルできないお知らせを出さない', async () => {
    const e = new Engine();
    const obj = e.world.addShape(0, 0, 0, 0);
    const fx = await e.mme.loadEffect([fileAt('Fx/good.fx', 'technique T { }')], 'good.fx');
    e.mme.assign(obj, 'Main', null, { folder: fx.folder.id, path: 'missing.fx' });
    e.ui.hideToast();
    const toast = vi.spyOn(e.ui, 'toast');
    e.selection.select(obj);
    e.mme.publish();
    expect(e.ui.state.mme.object).toBeNull();
    expect(toast).not.toHaveBeenCalled();
    // (大文字小文字が違っても、見つかればそれ)
    e.mme.assign(obj, 'Main', null, { folder: fx.folder.id, path: 'GOOD.fx' });
    expect(e.ui.state.mme.object).toMatchObject({ id: fx.id, ok: true });
  });

  it('エフェクト割当の行 (割り当て・既定) とフォルダの .fx・仮のコントローラーを出す。行は元が変わったときだけ作り直す', async () => {
    const e = new Engine();
    const obj = e.world.addShape(0, 0, 0, 0);
    e.addLight('point'); // (ライトは載せない)
    const good = await e.mme.loadEffect([fileAt('Fx/good.fx', 'technique T { }'), fileAt('Fx/sub/ctl.fx', 'float m : CONTROLOBJECT < string name = "ray_controller.pmx"; string item = "Red"; >;\ntechnique T { }')], 'good.fx');
    expect(e.ui.state.mme.folders).toEqual([{ id: good.folder.id, name: 'Fx', fx: ['good.fx', 'sub/ctl.fx'] }]);
    expect(e.ui.state.mme.rows.Main).toEqual([{ objId: obj.id, label: '立方体', material: null, assigned: null, fallback: 'default.fx', stopped: null }]);
    e.mme.assign(obj, 'Main', null, { folder: good.folder.id, path: 'GOOD.FX' });
    expect(e.ui.state.mme.rows.Main[0]).toMatchObject({ assigned: 'Fx/good.fx', fallback: 'default.fx' });
    e.mme.assign(obj, 'Main', null, 'hide');
    expect(e.ui.state.mme.rows.Main[0]).toMatchObject({ assigned: 'hide' });
    // 何も変わらなければ作り直さない
    const fallbackFor = vi.spyOn(e.mme.renderer.assignments, 'fallbackFor');
    e.mme.publish();
    e.mme.publish();
    expect(fallbackFor).not.toHaveBeenCalled();
    // 仮のコントローラー: 描いているエフェクトが読む名前と float の項目、その名前のコントローラーの物
    e.mme.assign(obj, 'Main', null, { folder: good.folder.id, path: 'sub/ctl.fx' });
    expect(fallbackFor).toHaveBeenCalled(); // (割り当てが変わったので作り直した)
    expect(e.ui.state.mme.controllers).toEqual([{ name: 'ray_controller.pmx', items: ['Red'], objId: null }]);
    const ctl = e.addMmeObject({ kind: 'controller', name: 'ray_controller.pmx' });
    expect(e.ui.state.mme.controllers).toEqual([{ name: 'ray_controller.pmx', items: ['Red'], objId: ctl.id }]);
    expect(e.ui.state.mme.values?.items).toEqual([{ name: 'Red', value: 0 }]);
    e.mme.setControl('RAY_CONTROLLER.pmx', 'Red', 0.25);
    expect(e.ui.state.mme.values?.items).toEqual([{ name: 'Red', value: 0.25 }]);
  });

  it('毎フレームの publish は、元 (割り当て・物・名前・マテリアル・フォルダ・タブ・止めたエフェクト) が変わらなければ物の材質やエフェクトを集め直さない', async () => {
    const e = new Engine();
    const obj = e.world.addShape(0, 0, 0, 0);
    const good = await e.mme.loadEffect([fileAt('Fx/good.fx', 'technique T { }')], 'good.fx');
    e.addMmeObject({ kind: 'controller', name: 'ray_controller.pmx' });
    e.mme.set({ engine: 'mme' });
    vi.spyOn(e.mme.renderer, 'render').mockReturnValue(true);
    const rows = vi.spyOn(e.mme as unknown as { rows(...a: unknown[]): unknown[] }, 'rows'); // (物ごとの行を作る)
    const drawnEffects = vi.spyOn(e.mme.renderer, 'drawnEffects');
    const rebuilt = () => {
      const n = [rows.mock.calls.length, drawnEffects.mock.calls.length];
      rows.mockClear();
      drawnEffects.mockClear();
      return n[0] > 0 && n[1] > 0;
    };
    e.viewport.drawOverride!(); // (前のフレームのタブを読む)
    rebuilt();
    for (let k = 0; k < 3; k++) e.viewport.drawOverride!();
    expect(rebuilt()).toBe(false);
    e.mme.setControl('ray_controller.pmx', 'Red', 0.5); // (値だけ: 並べ直すが、集め直さない)
    expect(rebuilt()).toBe(false);
    // 変わったら集め直す: 名前・割り当て・物を足す・フォルダ・止めた
    e.renameObj(obj, '箱');
    e.viewport.drawOverride!();
    expect(rebuilt()).toBe(true);
    expect(e.ui.state.mme.rows.Main[0].label).toBe('箱');
    e.mme.assign(obj, 'Main', null, ref(good));
    expect(rebuilt()).toBe(true);
    e.world.addShape(1, 1, 1, 0);
    e.viewport.drawOverride!();
    expect(rebuilt()).toBe(true);
    await e.mme.store.addFolder([fileAt('Other/x.fx', 'technique T { }')]);
    e.viewport.drawOverride!();
    expect(rebuilt()).toBe(true);
    ((e.mme.renderer as unknown as Internals).instance(good)).stopped = true;
    e.viewport.drawOverride!();
    expect(rebuilt()).toBe(true);
  });

  it('GPU で止めたエフェクトは、描くときと同じく既定の欄を Main では default.fx・オフスクリーンでは hide にして、行に止めたことを書く', async () => {
    const e = new Engine();
    const obj = e.world.addShape(0, 0, 0, 0);
    const good = await e.mme.loadEffect([fileAt('Fx/good.fx', 'technique T { }')], 'good.fx');
    // オフスクリーン Map (DefaultEffect = "* = good.fx;") を前のフレームに描いたことにする
    vi.spyOn(e.mme.renderer, 'offscreenTabs').mockReturnValue([{ name: 'Map', description: '' }]);
    vi.spyOn(e.mme.renderer, 'offscreenDefaults').mockReturnValue({ defaults: { rules: parseDefaultEffect('* = good.fx;').rules, base: '', folder: good.folder }, owners: new Set() });
    e.mme.assign(obj, 'Main', null, ref(good));
    expect(e.ui.state.mme.rows.Main[0]).toMatchObject({ assigned: 'Fx/good.fx', fallback: 'default.fx', stopped: null });
    expect(e.ui.state.mme.rows.Map[0]).toMatchObject({ assigned: null, fallback: 'Fx/good.fx', stopped: null });
    ((e.mme.renderer as unknown as Internals).instance(good)).stopped = true;
    e.mme.publish();
    expect(e.ui.state.mme.rows.Main[0]).toMatchObject({ assigned: 'Fx/good.fx', fallback: 'default.fx', stopped: 'Fx/good.fx' });
    expect(e.ui.state.mme.rows.Map[0]).toMatchObject({ assigned: null, fallback: 'hide', stopped: 'Fx/good.fx' });
    // 割り当てで別のもの (hide) にすれば、止めたことは書かない
    e.mme.assign(obj, 'Map', null, 'hide');
    expect(e.ui.state.mme.rows.Map[0]).toMatchObject({ assigned: 'hide', fallback: 'hide', stopped: null });
  });

  it('同じ名前のフォルダを読み直して .fx が増えると、どの読み方 (物の .fx・ポストエフェクト・EffectStore を直接) でもフォルダの .fx の一覧が変わる', async () => {
    const e = new Engine();
    const obj = e.world.addShape(0, 0, 0, 0);
    e.selection.select(obj);
    await e.mme.loadObjectEffect([fileAt('Fx/a.fx', 'technique T { }')], 'a.fx');
    expect(e.ui.state.mme.folders.map(f => f.fx)).toEqual([['a.fx']]);
    await e.mme.addPostEffect([fileAt('Fx/a.fx', 'technique T { }'), fileAt('Fx/b.fx', 'technique T { }')], 'b.fx');
    expect(e.ui.state.mme.folders.map(f => f.fx)).toEqual([['a.fx', 'b.fx']]);
    await e.mme.loadObjectEffect([fileAt('Fx/c.fx', 'technique T { }')], 'c.fx');
    expect(e.ui.state.mme.folders.map(f => f.fx)).toEqual([['a.fx', 'b.fx', 'c.fx']]);
    await e.mme.store.addFolder([fileAt('Fx/d.fx', 'technique T { }')]);
    e.mme.publish();
    expect(e.ui.state.mme.folders.map(f => f.fx)).toEqual([['a.fx', 'b.fx', 'c.fx', 'd.fx']]);
  });

  it('エラーは 20 個まで', async () => {
    const e = new Engine();
    const funcs = Array.from({ length: 30 }, (_, i) => `float4 f${i}() { return undefined${i}; }`).join('\n');
    const src = `${funcs}\nfloat4 PS() : COLOR0 { return ${Array.from({ length: 30 }, (_, i) => `f${i}()`).join(' + ')}; }\n`
      + 'technique T { pass P { PixelShader = compile ps_3_0 PS(); } }';
    const fx = await e.mme.loadEffect([fileAt('Fx/many.fx', src)], 'many.fx');
    e.mme.addPost(fx);
    expect(e.ui.state.mme.posts[0].ok).toBe(false);
    expect(e.ui.state.mme.posts[0].errors).toHaveLength(20);
    // 数はコンパイラの誤りの全部 (20 個のあとに「多いので止めました」)
    expect(fx.result.ok ? 0 : fx.result.errors.length).toBe(21);
    expect(e.ui.state.mme.posts[0].errorCount).toBe(21);
  });

  it('画面の操作: 選んでいる物に .fx を読む・外す、ポストエフェクトを足す、フォルダの .fx の一覧', async () => {
    const e = new Engine();
    const obj = e.world.addShape(0, 0, 0, 0);
    const files = () => [fileAt('Fx/a.fx', 'technique T { }'), fileAt('Fx/tex.png', '')];
    expect(e.mme.fxFilesIn([fileAt('F/b/c.fx', ''), fileAt('F/a.FX', ''), fileAt('F/t.png', '')])).toEqual(['a.FX', 'b/c.fx']);
    await e.mme.loadObjectEffect(files(), 'a.fx'); // (選んでいなければ何もしない)
    expect(obj.mme).toBeUndefined();
    e.selection.select(obj);
    const loading = e.mme.loadObjectEffect(files(), 'a.fx');
    e.selection.select(null); // 読んでいるあいだに選び直しても、押したときの物に当てる
    await loading;
    expect(obj.mme).toEqual({ Main: { object: { folder: e.mme.store.folders()[0].id, path: 'a.fx' } } });
    e.selection.select(obj);
    expect(e.ui.state.mme.object?.name).toBe('Fx/a.fx');
    e.mme.removeObjectEffect();
    expect(obj.mme).toBeUndefined();
    expect(e.ui.state.mme.object).toBeNull();
    await e.mme.addPostEffect([fileAt('P/post.fx', 'technique T { }')], 'post.fx');
    expect(e.ui.state.mme.posts.map(p => [p.name, p.enabled, p.accessory])).toEqual([['P/post.fx', true, 'post.x']]);
  });

  it('読めないファイルはお知らせを出す (例外を外に出さない)', async () => {
    const e = new Engine();
    const obj = e.world.addShape(0, 0, 0, 0);
    e.selection.select(obj);
    const broken = fileAt('Fx/a.fx', '');
    broken.arrayBuffer = () => Promise.reject(new Error('読めない'));
    await expect(e.mme.loadObjectEffect([broken], 'a.fx')).resolves.toBeUndefined();
    expect(e.ui.state.toast?.text).toContain('読めない');
    expect(obj.mme).toBeUndefined();
    e.ui.hideToast();
    await expect(e.mme.addPostEffect([broken], 'a.fx')).resolves.toBeNull();
    expect(e.ui.state.toast?.text).toContain('読めない');
    expect(e.mme.posts()).toEqual([]);
    expect(e.world.objects).toHaveLength(1); // (アクセサリは置かない)
  });

  it('まだ資源のないエフェクトの警告は、資源を作らずに全体の警告にする', async () => {
    const e = new Engine();
    const fx = await e.mme.loadEffect([fileAt('Fx/a.fx', 'technique T { }')], 'a.fx');
    const r = e.mme.renderer as unknown as Internals;
    r.warnFor(fx, 'まだ描いていない');
    expect(r.instances.has(fx)).toBe(false);
    expect(e.mme.renderer.warnings).toEqual(['Fx/a.fx: まだ描いていない']);
    r.instance(fx);
    r.warnFor(fx, '描いている');
    expect(e.mme.renderer.warningsOf(fx)).toEqual(['描いている']);
  });

  it('最初の状態に戻す (新しいプロジェクト・プロジェクトを開く) と、エフェクトの割り当ても消える', async () => {
    const e = new Engine();
    const obj = e.world.addShape(0, 0, 0, 0);
    const fx = await e.mme.loadEffect([fileAt('Fx/a.fx', 'technique T { }')], 'a.fx');
    const assign = () => { e.mme.assign(obj, 'Main', null, ref(fx)); e.mme.addPost(fx); };
    assign();
    e.mme.clearEffects(); // (場面にある物の割り当ても外す。アクセサリの割り当ても外れて、ポストエフェクトでなくなる)
    expect(obj.mme).toBeUndefined();
    expect(e.mme.posts()).toEqual([]);
    assign();
    e.resetAll();
    expect(e.mme.posts()).toEqual([]);
    expect(e.ui.state.mme.posts).toEqual([]);
    // プロジェクトを開いても (開く前に最初の状態に戻す)
    const shape = e.world.addShape(0, 0, 0, 0);
    const bytes = await e.project.save('reference');
    e.mme.assign(shape, 'Main', null, ref(fx));
    e.mme.addPost(fx);
    await e.project.open(bytes);
    expect(e.mme.posts()).toEqual([]);
    expect(e.world.objects.map(o => o.mme)).toEqual([undefined]);
  });
  // --- プロジェクト: MME の場面 (フォルダ・ポストエフェクト・仮のコントローラーの値) と、読んだファイル ---
  const TEX_FX = (image: string) => `
float4x4 WVP : WORLDVIEWPROJECTION;
texture Tex < string ResourceName = "${image}"; >;
sampler S = sampler_state { texture = <Tex>; };
float4 VS(float4 p : POSITION) : POSITION { return mul(p, WVP); }
float4 PS() : COLOR0 { return tex2D(S, float2(0.5, 0.5)); }
technique T < string MMDPass = "object"; > { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }`;
  const OFF_POST = (defaultEffect: string) => `
texture OffMap : OFFSCREENRENDERTARGET < float2 ViewportRatio = { 1.0, 1.0 }; string DefaultEffect = "${defaultEffect}"; >;
sampler OffSamp = sampler_state { texture = <OffMap>; };
float4 VS(float4 p : POSITION) : POSITION { return p; }
float4 PS() : COLOR0 { return tex2D(OffSamp, float2(0.5, 0.5)); }
technique Post { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }`;
  const bin = (path: string, bytes: number[]) => {
    const f = new File([new Uint8Array(bytes)], path.slice(path.lastIndexOf('/') + 1));
    Object.defineProperty(f, 'webkitRelativePath', { value: path });
    return f;
  };
  // フォルダ Fx: 画像を使う物の .fx・ポストエフェクト・使わない .fx・画像
  const fxFolder = () => [
    fileAt('Fx/a.fx', TEX_FX('tex.png')), fileAt('Fx/post.fx', OFF_POST('*=hide;')), fileAt('Fx/unused.fx', 'technique U { }'), bin('Fx/tex.png', [9, 8, 7]),
  ];
  const textOf = async (f: File | undefined) => (f ? new TextDecoder().decode(await f.arrayBuffer()) : null);
  // ポストエフェクト (隠したアクセサリのものも) のフォルダ・パス・コンパイルできたか・オンか (アクセサリを隠していないか)
  const postsOf = (e: Engine) => e.mme.posts(true).map(p => [p.effect.folder.id, p.effect.entry, p.effect.result.ok, !p.obj.hidden]);
  async function buildMmeScene(e: Engine) {
    const obj = e.world.addShape(0, 0, 0, 0);
    const a = await e.mme.loadEffect(fxFolder(), 'a.fx');
    e.mme.assign(obj, 'Main', null, ref(a));
    const acc = e.mme.addPost(e.mme.store.effect(a.folder, 'post.fx'))!;
    e.setVisibility(acc, OFF);
    e.addMmeObject({ kind: 'controller', name: 'Ctrl' });
    e.mme.setControl('Ctrl', 'Si', 0.7);
    e.mme.set({ engine: 'mme', selfShadow: false });
    return a.folder.id;
  }
  async function expectMmeScene(e: Engine, id: string) {
    expect(e.mme.store.folders().map(f => [f.id, f.name, [...f.files.keys()].sort()])).toEqual([[id, 'Fx', ['a.fx', 'post.fx', 'tex.png']]]);
    const folder = e.mme.store.folder(id)!;
    expect(await textOf(folder.files.get('a.fx'))).toBe(TEX_FX('tex.png'));
    expect(new Uint8Array(await folder.files.get('tex.png')!.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    expect(postsOf(e)).toEqual([[id, 'post.fx', true, false]]);
    expect(e.mme.controllers.controller('Ctrl')?.mmeValues?.Si).toBeCloseTo(0.7, 6);
    expect(e.mme.settings).toMatchObject({ engine: 'mme', selfShadow: false });
    const [obj, acc] = e.world.objects;
    expect([acc.mmeObj, acc.hidden, acc.hideRender]).toEqual([{ kind: 'accessory', name: 'post.x' }, true, true]);
    expect(obj.mme).toEqual({ Main: { object: { folder: id, path: 'a.fx' } } });
    expect(e.mme.renderer.assignments.referenced(obj).map(x => x.result.ok)).toEqual([true]);
  }

  it('MME の場面と、実際に読んだファイル (描く前の画像も) を .wgp に入れ、開き直すと同じ id のフォルダ・ポストエフェクト・コントローラーの値に戻る', async () => {
    const e = new Engine();
    const id = await buildMmeScene(e);
    const bytes = await e.project.save('embedded');
    const { data } = await readEmbedded(bytes);
    expect(data.mme).toEqual({
      settings: { ...MME_DEFAULTS, engine: 'mme', selfShadow: false }, folders: [{ id, name: 'Fx' }],
    }); // (ポストエフェクトはアクセサリ、コントローラーの値はコントローラーの物の値。場面の値 posts・controls は書かない)
    // (使わない .fx は入れない。画像は、まだ描いていなくても入る)
    const mmeFiles = data.mmeFiles as { folder: string; path: string; asset: string }[];
    expect(mmeFiles.map(m => [m.folder, m.path])).toEqual([[id, 'a.fx'], [id, 'post.fx'], [id, 'tex.png']]);
    expect(mmeFiles.map(m => data.assets.find(a => a.id === m.asset)?.name)).toEqual(['a.fx', 'post.fx', 'tex.png']);

    const f = new Engine();
    await f.project.open(bytes);
    await expectMmeScene(f, id);
    expect(f.ui.state.toast).toBeNull(); // (エラーのお知らせはない)
    // 次に読むフォルダは、開いたフォルダと別の id
    expect((await f.mme.store.addFolder([fileAt('Other/o.fx', '')])).id).not.toBe(id);
  });

  it('.wgpj: このページで読んだフォルダのファイル (フォルダの名前とパスと大きさ) を使い、なければ探してもらったファイルを使う', async () => {
    const e = new Engine();
    const id = await buildMmeScene(e);
    const bytes = await e.project.save('reference');
    // 同じページ: 探してもらわない
    const pick = vi.fn(async () => 'skip' as const);
    await e.project.open(bytes, { pick });
    expect(pick).not.toHaveBeenCalled();
    await expectMmeScene(e, id);
    // ほかのページ: 探してもらったファイル (名前と大きさで照らし合わせる)
    const f = new Engine();
    const picked = vi.fn(async () => fxFolder());
    await f.project.open(bytes, { pick: picked });
    expect(picked).toHaveBeenCalledTimes(1);
    await expectMmeScene(f, id);
  });

  // Ray-MMD には、名前も大きさも更新日時も同じで中身の違うファイルが別のフォルダにある (Lighting/SpotLight/Default と Default Ambient など)
  const twins = (root = 'Ray') => [
    fileAt(`${root}/Lighting/Default/spot.fx`, 'technique A { }', 5), fileAt(`${root}/Lighting/Default Ambient/spot.fx`, 'technique B { }', 5),
  ].reverse(); // (名前で照らすと、先にある Default Ambient のものを取り違える)
  const techniques = (e: Engine) => e.mme.posts().map(p => (p.effect.result.ok ? p.effect.result.effect.techniques[0].name : null));
  async function twinPosts(e: Engine) {
    const folder = await e.mme.store.addFolder(twins());
    e.mme.addPost(e.mme.store.effect(folder, 'Lighting/Default/spot.fx'));
    e.mme.addPost(e.mme.store.effect(folder, 'Lighting/Default Ambient/spot.fx'));
    expect(techniques(e)).toEqual(['A', 'B']);
  }

  it('.wgpj を開いて探してもらったフォルダから、MME のフォルダのファイルは相対パスで探す (名前と大きさが同じ別のファイルと取り違えない)', async () => {
    const e = new Engine();
    await twinPosts(e);
    const bytes = await e.project.save('reference');
    for (const root of ['Ray', 'Renamed']) { // (選んだフォルダの名前が違っても、フォルダの中のパスで)
      const f = new Engine();
      await f.project.open(bytes, { pick: async () => twins(root) });
      expect(techniques(f), root).toEqual(['A', 'B']);
    }
  });

  it('同じページで .wgpj を開き直しても (間にほかのプロジェクトを開いても)、MME のフォルダのファイルを名前と大きさだけで取り違えない', async () => {
    const e = new Engine();
    await twinPosts(e);
    const bytes = await e.project.save('reference');
    const f = new Engine();
    await f.project.open(bytes, { pick: async () => twins() });
    expect(techniques(f)).toEqual(['A', 'B']);
    // ほかのプロジェクトを開く (MME のフォルダは空になる) → 開き直す。このページで覚えたファイルから、フォルダの中のパスで探す
    await f.project.open(await new Engine().project.save('reference'));
    expect(f.mme.store.folders()).toEqual([]);
    const pick = vi.fn(async () => 'skip' as const);
    await f.project.open(bytes, { pick });
    expect(pick).not.toHaveBeenCalled();
    expect(techniques(f)).toEqual(['A', 'B']);
  });

  it('.wgpj を開いて相対パスのないファイルを選んだときは、同じ名前・大きさのものが 2 つある MME のファイルを名前で当てない (取り違えるより、見つからないほうにする)', async () => {
    const e = new Engine();
    await twinPosts(e);
    const bytes = await e.project.save('reference');
    const loose = () => twins().map(f => new File([f], f.name)); // (webkitRelativePath のないファイル)
    const f = new Engine();
    const answers: (File[] | 'skip')[] = [loose(), 'skip'];
    await f.project.open(bytes, { pick: async () => answers.shift() ?? 'cancel' });
    expect(answers).toEqual([]); // (2 回目も聞かれた = 名前では当てなかった)
    expect(techniques(f)).toEqual([null, null]);
    // 1 つしかないものは、相対パスがなくても名前と大きさで当てる
    const g = new Engine();
    const id = await buildMmeScene(g);
    const ref2 = await g.project.save('reference');
    const h = new Engine();
    await h.project.open(ref2, { pick: async () => fxFolder().map(x => new File([x], x.name)) });
    await expectMmeScene(h, id);
  });

  it('.wgpj で見つからないファイルは、そのファイルなしでフォルダを作る (割り当てとポストエフェクトは残し、描かない)', async () => {
    const e = new Engine();
    const id = await buildMmeScene(e);
    const bytes = await e.project.save('reference');
    const f = new Engine();
    // (a.fx だけ見つかる。まだ見つからないものがあると、もう一度聞かれるので、見つかったものだけで開く)
    const answers: (File[] | 'skip')[] = [[fxFolder()[0]], 'skip'];
    await f.project.open(bytes, { pick: async () => answers.shift() ?? 'cancel' });
    expect(f.mme.store.folders().map(x => [x.id, [...x.files.keys()]])).toEqual([[id, ['a.fx']]]);
    expect(f.world.objects[0].mme).toEqual({ Main: { object: { folder: id, path: 'a.fx' } } });
    expect(f.mme.posts(true).map(p => [p.effect.entry, p.effect.result.ok])).toEqual([['post.fx', false]]);
    // 保存し直しても、ポストエフェクトの参照 (アクセサリの割り当て) は残る
    const again = JSON.parse(new TextDecoder().decode(await f.project.save('reference')));
    const savedAccessories = again.objects.filter((o: { mmeObj?: { kind: string } }) => o.mmeObj?.kind === 'accessory');
    expect(savedAccessories.map((o: { mme?: unknown }) => o.mme)).toEqual([{ Main: { object: { folder: id, path: 'post.fx' } } }]);
    // 同じフォルダを読み直す (同じ名前なのでまとめる) と、ポストエフェクトも直る (並びとオン・オフはそのまま。割り当ては描くたびに引き直す)
    const other = await f.mme.loadEffect([fileAt('Other/o.fx', 'technique O { }')], 'o.fx');
    f.mme.addPost(other);
    const changed = vi.fn();
    f.mme.store.events.on('changed', changed);
    await f.mme.loadEffect(fxFolder(), 'a.fx');
    expect(f.mme.store.folders().map(x => x.id)).toEqual([id, other.folder.id]);
    expect(postsOf(f)).toEqual([[id, 'post.fx', true, false], [other.folder.id, 'o.fx', true, true]]);
    expect(f.mme.posts()[0].effect).toBe(other);
    expect(changed).toHaveBeenCalled();
    f.mme.publish();
    expect(f.ui.state.mme.posts.map(p => p.ok)).toEqual([true, true]);
  });

  it('保存の前に、ポストエフェクトのオフスクリーンの DefaultEffect で描く .fx とその画像も (まだ描いていなくても) 読んだファイルにする', async () => {
    const e = new Engine();
    e.world.addShape(0, 0, 0, 0);
    const post = await e.mme.loadEffect([fileAt('P/post.fx', OFF_POST('*=sub/off.fx;')), fileAt('P/sub/off.fx', TEX_FX('off.png')), bin('P/sub/off.png', [1])], 'post.fx');
    e.mme.addPost(post);
    const { data } = await readEmbedded(await e.project.save('embedded'));
    expect((data.mmeFiles as { path: string }[]).map(m => m.path)).toEqual(['post.fx', 'sub/off.fx', 'sub/off.png']);
    // (画像は読まず、標準のエンジンのあいだは MME の資源を作らない)
    expect((e.mme.renderer as unknown as Internals).instances.size).toBe(0);
  });

  it('whenReady (書き出しの前) も、オフスクリーンの DefaultEffect で描く .fx の画像を、まだ描いていなくても待つ。オフのポストエフェクトのものは待たない', async () => {
    const e = new Engine();
    e.world.addShape(0, 0, 0, 0); // (規則 * で描く物)
    const on = await e.mme.loadEffect([fileAt('On/post.fx', OFF_POST('*=off.fx;')), fileAt('On/off.fx', TEX_FX('on.png')), bin('On/on.png', [1])], 'post.fx');
    const off = await e.mme.loadEffect([fileAt('Off/post.fx', OFF_POST('*=off.fx;')), fileAt('Off/off.fx', TEX_FX('off.png')), bin('Off/off.png', [2])], 'post.fx');
    e.mme.addPost(on);
    e.setVisibility(e.mme.addPost(off)!, OFF);
    await e.mme.whenReady();
    expect([...on.folder.used].sort()).toEqual(['off.fx', 'on.png', 'post.fx']);
    expect([...off.folder.used].sort()).toEqual(['post.fx']);
  });

  it('保存の前に読んだファイルにするのは、DefaultEffect の規則のうち場面の物かステージを描くもの (名前ごとに最初に合う規則) の .fx だけ', async () => {
    const e = new Engine();
    const rules = 'self=hide;Doll*=doll.fx;D*=shadowed.fx;Lamp=lamp.fx;Time of day.pmx=sky.fx;*=hide;';
    const files = ['doll', 'shadowed', 'lamp', 'sky'].map(n => fileAt(`R/${n}.fx`, TEX_FX(`${n}.png`)));
    const pngs = ['doll', 'shadowed', 'lamp', 'sky'].map(n => bin(`R/${n}.png`, [1]));
    const post = await e.mme.loadEffect([fileAt('R/post.fx', OFF_POST(rules)), ...files, ...pngs], 'post.fx');
    e.mme.addPost(post);
    const saved = async () => {
      const { data } = await readEmbedded(await e.project.save('embedded'));
      return (data.mmeFiles as { path: string }[]).map(m => m.path);
    };
    // 物がなければ、規則の .fx は読まない (ポストエフェクトのアクセサリ post.x は、どの .fx の規則にも合わない)
    expect(await saved()).toEqual(['post.fx']);
    // Doll で始まる物 (D* より先に合う) だけ
    const doll = e.world.addShape(0, 0, 0, 0);
    doll.name = 'Dolly';
    expect(await saved()).toEqual(['doll.fx', 'doll.png', 'post.fx']);
    // ステージは .pmx のファイル名で照らす
    const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    mesh.userData.sourceFile = new File([], 'Time of day.pmx');
    const stage = new THREE.Group();
    stage.add(mesh);
    stage.userData.sourceFile = mesh.userData.sourceFile; // (保存するステージのファイル)
    e.stage.model = stage;
    expect(await saved()).toEqual(['doll.fx', 'doll.png', 'post.fx', 'sky.fx', 'sky.png']);
  });

  it('used にあってフォルダにないパスは保存しない (例外にならない)', async () => {
    const e = new Engine();
    const fx = await e.mme.loadEffect([fileAt('Fx/a.fx', 'technique T { }')], 'a.fx');
    e.mme.addPost(fx);
    fx.folder.used.add('ghost.png');
    const { data } = await readEmbedded(await e.project.save('embedded'));
    expect((data.mmeFiles as { path: string }[]).map(m => m.path)).toEqual(['a.fx']);
  });

  it('オフスクリーンの宣言の警告は、使わなくなって資源 (EffectInstance) を捨てたあとに作り直しても、またそのエフェクトの警告に出る', async () => {
    const e = new Engine();
    const post = await e.mme.loadEffect([fileAt('Off/post.fx', OFF_POST('broken;*=hide;'))], 'post.fx');
    const warning = 'OffMap: DefaultEffect の項 "broken" に = がないので無視します';
    const r = e.mme.renderer as unknown as Internals & { offscreen: { declsOf(e: LoadedEffect, screen: [number, number]): unknown } };
    const acc = e.mme.addPost(post)!;
    r.instance(post);
    r.offscreen.declsOf(post, [64, 64]); // (描くときに宣言を読む)
    expect(e.mme.renderer.warningsOf(post)).toEqual([warning]);
    e.world.remove(acc); // (使わなくなったので資源を捨てる)
    expect(r.instances.has(post)).toBe(false);
    e.mme.addPost(post);
    r.instance(post);
    r.offscreen.declsOf(post, [64, 64]); // (宣言は覚えているので、読み直さない)
    expect(e.mme.renderer.warningsOf(post)).toEqual([warning]);
  });

  it('第 2 の計画の形の mme (設定だけ) のプロジェクトも、お知らせなしで開ける', async () => {
    const e = new Engine();
    const json = JSON.parse(new TextDecoder().decode(await e.project.save('reference')));
    json.mme = { engine: 'mme', selfShadow: false, shadowDistance: 5000, groundShadow: true };
    delete json.mmeFiles;
    const f = new Engine();
    await f.project.open(new TextEncoder().encode(JSON.stringify(json)));
    expect(f.mme.settings).toEqual(json.mme);
    expect(f.mme.store.folders()).toEqual([]);
    expect(f.ui.state.toast).toBeNull();
  });

  it('第 4 の計画の形の mme (場面の値 controls) のプロジェクトを開くと、名前ごとにコントローラーの物を作って値を移す (開いた状態の一部で、元に戻す手にしない)', async () => {
    const e = new Engine();
    e.world.addShape(0, 0, 0, 0);
    const json = JSON.parse(new TextDecoder().decode(await e.project.save('reference')));
    expect('controls' in json.mme).toBe(false);
    json.mme.controls = { Ctrl: { Si: 0.7, Tr: 2 }, 'ray_controller.pmx': { 'SSAO+': 0.25 } };
    const f = new Engine();
    await f.project.open(new TextEncoder().encode(JSON.stringify(json)));
    const controllers = f.world.objects.filter(o => o.mmeObj);
    expect(controllers.map(o => [o.mmeObj, o.mmeValues, o.mmeChannels])).toEqual([
      [{ kind: 'controller', name: 'Ctrl' }, { Si: 0.7, Tr: 1 }, ['Si', 'Tr']],
      [{ kind: 'controller', name: 'ray_controller.pmx' }, { 'SSAO+': 0.25 }, ['SSAO+']],
    ]);
    expect(f.mme.controllers.value({ param: 'm', name: 'Ctrl', item: 'Si', type: 'float' }, null, null)).toEqual([0.7]);
    expect(f.history.canUndo).toBe(false);
    expect(f.ui.state.toast).toBeNull();
    expect('controls' in f.mme.saveScene()).toBe(false);
    // 名前がもうコントローラーの物にあれば、その物に入れる (作らない)
    const g = new Engine();
    const own = g.addMmeObject({ kind: 'controller', name: 'ctrl' });
    g.mme.loadScene({ ...g.mme.saveScene(), controls: { Ctrl: { Si: 0.5 } } });
    expect(g.world.objects).toEqual([own]);
    expect(own.mmeValues).toEqual({ Si: 0.5 });
  });

  it('古い controls の名前が場面のほかの物にある (値は使われていなかった) なら移さず、知らせない', () => {
    const e = new Engine();
    e.world.addShape(0, 0, 0, 0);
    e.renameObj(e.world.objects[0], 'Taken');
    e.mme.loadScene({ ...e.mme.saveScene(), controls: { taken: { Si: 0.5 } } });
    expect(e.world.objects.filter(o => o.mmeObj)).toEqual([]);
    expect(e.mme.takeOpenNotes()).toEqual([]);
  });

  // 第 4 の計画の形の controls を持つプロジェクトのファイル
  const legacyFile = async (controls: Record<string, Record<string, number>>) => {
    const json = JSON.parse(new TextDecoder().decode(await new Engine().project.save('reference')));
    json.mme.controls = controls;
    return new File([JSON.stringify(json)], 'old.wgpj');
  };
  const controllersOf = (e: Engine) => e.world.objects.filter(o => o.mmeObj).map(o => [o.mmeObj!.name, o.mmeValues]);

  it('古い controls を移せなかった (置ける数を超えた) ことは、開いたお知らせに名前をまとめて添える', async () => {
    const f = new Engine();
    const full = vi.spyOn(f.world, 'full', 'get').mockReturnValue(true);
    await f.project.openFile(await legacyFile({ A: { Si: 0.5 }, B: { Si: 0.25 } }));
    full.mockRestore();
    expect(controllersOf(f)).toEqual([]);
    expect(f.ui.state.toast?.text).toBe('old.wgpj を開きました (古いプロジェクトのコントローラー A・B の値を移せませんでした (これ以上置けません))');
    expect(f.mme.takeOpenNotes()).toEqual([]); // (一度読んだら忘れる)
  });

  it('古い controls の名前: 空になるものは移さず、直したもの (前後の空白・64 文字より長い) は直した名前で移して、合わないことを開いたお知らせに添える。開くのはやめない', async () => {
    const long = 'L'.repeat(70);
    const f = new Engine();
    await f.project.openFile(await legacyFile({ '   ': { Si: 0.5 }, ' Ctrl ': { Si: 0.75 }, [long]: { Si: 0.25 }, ok: { Si: 1 } }));
    expect(controllersOf(f)).toEqual([['Ctrl', { Si: 0.75 }], ['L'.repeat(64), { Si: 0.25 }], ['ok', { Si: 1 }]]);
    expect(f.ui.state.toast?.text).toBe(`old.wgpj を開きました (古いプロジェクトのコントローラー "   " は名前が空なので、値を移せませんでした。`
      + `古いプロジェクトのコントローラー " Ctrl "・"${long}" は名前を直して移したので、.fx が読む名前と合いません)`);
  });

  it('最初の状態に戻すと、フォルダ・仮のコントローラーの値・ポストエフェクト・割り当て・設定を消す', async () => {
    const e = new Engine();
    await buildMmeScene(e);
    e.resetAll();
    expect(e.mme.store.folders()).toEqual([]);
    expect(e.world.objects).toEqual([]); // (コントローラー・アクセサリの物も)
    expect(e.mme.posts(true)).toEqual([]);
    expect(e.mme.settings).toEqual(MME_DEFAULTS);
    expect(e.ui.state.mme.folders).toEqual([]);
  });

  it('ステージの割り当て: 画面のどのタブにもステージの行 (先頭・材質の行つき) が出て、assignStage で変わる (元に戻すの手にしない)。保存して開き直すと戻り、最初の状態に戻すと消える', async () => {
    const e = new Engine();
    const fx = await e.mme.loadEffect([fileAt('Fx/sky.fx', 'technique T { }')], 'sky.fx');
    const mats = [new THREE.MeshBasicMaterial({ name: '空' }), new THREE.MeshBasicMaterial({ name: '雲' })];
    const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(), mats);
    mesh.userData.sourceFile = new File([], 'Time of day.pmx');
    const stage = new THREE.Group();
    stage.add(mesh);
    e.stage.model = stage;
    e.graph.scene.add(stage);
    e.world.addShape(0, 0, 0, 0);
    e.ui.set({ sceneVersion: e.ui.state.sceneVersion + 1 }); // (ステージを替えたときと同じ)
    e.mme.publish();
    const edited = vi.spyOn(e.history, 'soon');
    const stageRows = () => e.ui.state.mme.rows.Main.filter(r => r.objId === -1).map(r => [r.label, r.material, r.assigned, r.fallback]);
    expect(stageRows()).toEqual([['ステージ: Time of day.pmx', null, null, 'default.fx'], ['空', 0, null, 'default.fx'], ['雲', 1, null, 'default.fx']]);
    expect(e.ui.state.mme.rows.Main[0].objId).toBe(-1); // (先頭)

    e.mme.assignStage('Main', null, ref(fx));
    e.mme.assignStage('Main', 1, 'hide');
    expect(edited).not.toHaveBeenCalled();
    expect(stageRows()).toEqual([['ステージ: Time of day.pmx', null, 'Fx/sky.fx', 'default.fx'], ['空', 0, null, 'Fx/sky.fx'], ['雲', 1, 'hide', 'Fx/sky.fx']]);
    const slotFor = e.mme.renderer.assignments.slotFor('Main', null, null);
    expect([0, 1].map(i => { const sl = slotFor(null, mesh, i); return sl.kind === 'hide' ? 'hide' : sl.effect; })).toEqual([fx, 'hide']);
    expect(e.mme.renderer.drawnEffects()).toContain(fx);
    e.mme.assignStage('Main', 1, null);
    expect(stageRows()[2]).toEqual(['雲', 1, null, 'Fx/sky.fx']);
    expect(e.mme.saveScene().stage).toEqual({ Main: { object: ref(fx) } });

    // (割り当ては場面の値なので、ステージを外しても残る。手で作ったステージはファイルがなくて保存できないので外す)
    e.graph.scene.remove(stage);
    e.stage.model = null;
    expect(e.mme.saveScene().stage).toEqual({ Main: { object: ref(fx) } });
    const f = new Engine();
    await f.project.open(await e.project.save('embedded'));
    expect(f.mme.saveScene().stage).toEqual({ Main: { object: ref(fx) } });
    expect(f.mme.renderer.assignments.referencedStage().map(x => [x.entry, x.result.ok])).toEqual([['sky.fx', true]]);
    f.resetAll();
    expect('stage' in f.mme.saveScene()).toBe(false);
  });
  // --- .fx のパラメータの値 (設計書「パラメータ」): 「.fx を当てた物」と「.fx」の組ごと。描くたびにその物の値で uniform を上書きする ---
  const paramFx = (decls = 'float Strength < float UIMin = 0; float UIMax = 4; > = 1;', ps = 'return float4(Strength, 0, 0, 1);') => `
float4x4 WVP : WORLDVIEWPROJECTION;
${decls}
float4 VS(float4 p : POSITION) : POSITION { return mul(p, WVP); }
float4 PS() : COLOR0 { ${ps} }
technique T < string MMDPass = "object"; > { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }`;
  type DrawInternals = {
    fb: unknown; main: PassTable; frame(renderer: unknown): FrameState; instance(e: LoadedEffect): EffectInstance;
    scenePass: { draw(table: PassTable, frame: FrameState, target: DrawTarget): void };
  };
  const TARGET = { size: [320, 240], flipY: 1 } as DrawTarget;
  // 描画先の代わり (何も描かない)
  const fakeFb = () => ({
    defaultSurface: null, current: null, clear: () => {}, bindSurface: () => TARGET, bind: () => TARGET, afterDraw: () => {}, has: () => true, colorTexture: () => null,
  });
  // fn のあいだに bind したパラメータ name の uniform の値を、描いた順に集める
  function captureParam(name: string, fn: () => void): unknown[] {
    const seen: unknown[] = [];
    const bind = EffectInstance.prototype.bind;
    const spy = vi.spyOn(EffectInstance.prototype, 'bind').mockImplementation(function (this: EffectInstance, ...args: Parameters<EffectInstance['bind']>) {
      bind.apply(this, args);
      const [m, pass] = args;
      const u = pass.program?.uniforms.find(x => x.name === name);
      if (u) seen.push(m.uniforms[u.glslName].value);
    });
    try { fn(); } finally { spy.mockRestore(); }
    return seen;
  }
  // 描画先なしで表 (なければ Main の表) の物を描き、パラメータ name の uniform の値を描いた順に集める
  function drawnParam(e: Engine, name: string, table?: PassTable): unknown[] {
    const r = e.mme.renderer as unknown as DrawInternals;
    const renderer = {
      renderBufferDirect: () => {}, properties: { get: () => ({}) }, getContext: () => ({}), extensions: { has: () => false },
      getDrawingBufferSize: (v: THREE.Vector2) => v.set(320, 240),
    };
    e.viewport.renderer = renderer as unknown as THREE.WebGLRenderer;
    r.fb = fakeFb();
    try {
      return captureParam(name, () => r.scenePass.draw(table ?? r.main, r.frame(renderer), TARGET));
    } finally {
      e.viewport.renderer = null;
      r.fb = null;
    }
  }

  it('パラメータの値は物ごと: 同じ .fx を当てた 2 つの物の片方だけ Strength を 3 にすると、描くたびにそれぞれの値 (もう片方は初期値)。範囲の外は収め、物の値なので元に戻せる', async () => {
    const e = new Engine();
    const a = e.world.addShape(0, 0, 0, 0), b = e.world.addShape(0, 3, 0, 1);
    const fx = await e.mme.loadEffect([fileAt('Fx/param.fx', paramFx())], 'param.fx');
    e.mme.assign(a, 'Main', null, ref(fx));
    e.mme.assign(b, 'Main', null, ref(fx));
    e.history.checkpoint();
    const ch = `${fx.folder.id}/param.fx:Strength`;
    const draw = vi.spyOn(e.viewport, 'requestDraw');
    const edited = vi.spyOn(e.history, 'soon');
    const sceneEdited = vi.spyOn(e.autosave, 'schedule');
    e.mme.setParam(a, fx.folder.id, 'PARAM.FX', 'Strength', [3]); // (パスの大文字小文字は問わない)
    expect(a.mmeValues).toEqual({ [ch]: 3 });
    expect(a.mmeChannels).toEqual([ch]);
    expect(b.mmeValues).toBeUndefined();
    expect(draw).toHaveBeenCalled();
    expect(edited).toHaveBeenCalled();
    expect(sceneEdited).not.toHaveBeenCalled(); // (自動保存は履歴の手から)
    expect(drawnParam(e, 'Strength')).toEqual([3, 1]);
    // 範囲 (UIMin・UIMax) の外は収める
    e.mme.setParam(a, fx.folder.id, 'param.fx', 'Strength', [9]);
    e.mme.setParam(b, fx.folder.id, 'param.fx', 'Strength', [-1]);
    expect([a.mmeValues, b.mmeValues]).toEqual([{ [ch]: 4 }, { [ch]: 0 }]);
    expect(drawnParam(e, 'Strength')).toEqual([4, 0]);
    // 知らないパラメータ・フォルダ・ファイルには何もしない
    e.mme.setParam(a, fx.folder.id, 'param.fx', 'NoSuch', [1]);
    e.mme.setParam(a, 'nofolder', 'param.fx', 'Strength', [1]);
    e.mme.setParam(a, fx.folder.id, 'none.fx', 'Strength', [1]);
    expect(a.mmeValues).toEqual({ [ch]: 4 });
    // 画面の値 (いまのパラメータ)
    expect(e.mme.paramsOf(a)).toEqual([{
      effect: { folder: fx.folder.id, path: 'param.fx', name: 'Fx/param.fx' },
      params: [{ name: 'Strength', label: 'Strength', type: 'float', init: [1], min: 0, max: 4, color: false, value: [4] }],
    }]);
    e.history.checkpoint();
    await e.history.undo();
    expect([a.mmeValues, b.mmeValues]).toEqual([undefined, undefined]);
    expect(drawnParam(e, 'Strength')).toEqual([1, 1]);
    await e.history.redo();
    expect(drawnParam(e, 'Strength')).toEqual([4, 0]);
  });

  it('ベクトルのパラメータは成分ごとのチャンネル (:x :y :z)。キーフレームで描く値がフレームごとに変わる', async () => {
    const e = new Engine();
    const a = e.world.addShape(0, 0, 0, 0);
    const fx = await e.mme.loadEffect([fileAt('Fx/col.fx', paramFx('float3 Col < string UIWidget = "Color"; > = {1, 0, 0};', 'return float4(Col, 1);'))], 'col.fx');
    e.mme.assign(a, 'Main', null, ref(fx));
    const chs = ['x', 'y', 'z'].map(c => `${fx.folder.id}/col.fx:Col:${c}`);
    e.mme.setParam(a, fx.folder.id, 'col.fx', 'Col', [0, 1, 0]);
    expect(a.mmeChannels).toEqual(chs);
    expect(drawnParam(e, 'Col')).toEqual([[0, 1, 0]]);
    e.keyframes.insertMme(a, 0, chs);
    e.mme.setParam(a, fx.folder.id, 'col.fx', 'Col', [0, 0, 1]);
    e.keyframes.insertMme(a, 30, chs);
    e.keyframes.applyAll(0, true); // (0 フレーム)
    expect(drawnParam(e, 'Col')).toEqual([[0, 1, 0]]);
    e.keyframes.applyAll(1, true); // (30 フレーム = 1 秒)
    expect(drawnParam(e, 'Col')).toEqual([[0, 0, 1]]);
    expect(e.mme.paramsOf(a)[0].params[0]).toMatchObject({ name: 'Col', color: true, value: [0, 0, 1] });
  });

  it('DefaultEffect だけで決まった物の .fx は初期値で描く (物の値があっても)。そのタブで当てると物の値で描く', async () => {
    const e = new Engine();
    const a = e.world.addShape(0, 0, 0, 0), b = e.world.addShape(0, 3, 0, 1);
    const fx = await e.mme.loadEffect([fileAt('Fx/param.fx', paramFx())], 'param.fx');
    e.mme.assign(a, 'Main', null, ref(fx));
    e.mme.setParam(a, fx.folder.id, 'param.fx', 'Strength', [3]);
    const defaults = { rules: parseDefaultEffect('*=param.fx').rules, base: '', folder: fx.folder };
    const table: PassTable = { name: 'Map', owner: null, slotFor: e.mme.renderer.assignments.slotFor('Map', defaults, null) };
    expect(drawnParam(e, 'Strength', table)).toEqual([1, 1]);
    expect(drawnParam(e, 'Strength')).toEqual([3]); // (Main は当てた a だけ。b は default.fx)
    e.mme.assign(a, 'Map', null, ref(fx));
    expect(drawnParam(e, 'Strength', table)).toEqual([3, 1]);
    expect(e.mme.paramsOf(a).map(x => x.effect.path)).toEqual(['param.fx']); // (同じ .fx は 1 つ)
    expect(e.mme.paramsOf(b)).toEqual([]);
  });

  it('.fx を読み直してパラメータがなくなっても例外にならず、画面に出ない。古いチャンネルとキーは残る', async () => {
    const e = new Engine();
    const a = e.world.addShape(0, 0, 0, 0);
    const both = 'float Strength < float UIMin = 0; float UIMax = 4; > = 1;\nfloat3 Col = {1, 0, 0};';
    const fx = await e.mme.loadEffect([fileAt('Fx/param.fx', paramFx(both, 'return float4(Col * Strength, 1);'), 1)], 'param.fx');
    e.mme.assign(a, 'Main', null, ref(fx));
    e.mme.setParam(a, fx.folder.id, 'param.fx', 'Strength', [3]);
    const ch = `${fx.folder.id}/param.fx:Strength`;
    e.keyframes.insertMme(a, 0, [ch]);
    expect(e.mme.paramsOf(a)[0].params.map(p => p.name)).toEqual(['Strength', 'Col']);
    const fx2 = await e.mme.loadEffect([fileAt('Fx/param.fx', paramFx('float3 Col = {1, 0, 0};', 'return float4(Col, 1);'), 2)], 'param.fx');
    expect(fx2).not.toBe(fx);
    expect(drawnParam(e, 'Strength')).toEqual([]);
    expect(drawnParam(e, 'Col')).toEqual([[1, 0, 0]]);
    expect(e.mme.paramsOf(a)[0].params.map(p => p.name)).toEqual(['Col']);
    e.mme.setParam(a, fx.folder.id, 'param.fx', 'Strength', [1]); // (もうないので何もしない)
    expect(a.mmeChannels).toEqual([ch]);
    expect(a.mmeValues).toEqual({ [ch]: 3 });
    expect(a.anim?.mme.get(0)?.size).toBe(1);
    expect(() => e.keyframes.applyAll(0, true)).not.toThrow();
  });

  it('ステージのパラメータは場面の値 (元に戻すの対象にしない)。描くときにステージの .fx を上書きし、保存して開き直すと戻り、最初の状態に戻すと消える', async () => {
    const e = new Engine();
    const fx = await e.mme.loadEffect([fileAt('Fx/param.fx', paramFx())], 'param.fx');
    const stage = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    e.stage.model = stage;
    e.graph.scene.add(stage);
    const a = e.world.addShape(0, 0, 0, 0);
    e.mme.assignStage('Main', null, ref(fx));
    e.mme.assign(a, 'Main', null, ref(fx));
    const ch = `${fx.folder.id}/param.fx:Strength`;
    const edited = vi.spyOn(e.history, 'soon');
    const sceneEdited = vi.spyOn(e.autosave, 'schedule');
    e.mme.setParam('stage', fx.folder.id, 'param.fx', 'Strength', [9]);
    expect(edited).not.toHaveBeenCalled();
    expect(sceneEdited).toHaveBeenCalled();
    expect(e.mme.saveScene().stageParams).toEqual({ [ch]: 4 });
    expect(a.mmeValues).toBeUndefined();
    expect(drawnParam(e, 'Strength')).toEqual([4, 1]); // (ステージ → 置いた物)
    expect(e.mme.paramsOf('stage')[0].params[0]).toMatchObject({ name: 'Strength', value: [4] });
    // (手で作ったステージはファイルがなくて保存できないので外す)
    e.graph.scene.remove(stage);
    e.stage.model = null;
    const f = new Engine();
    await f.project.open(await e.project.save('embedded'));
    expect(f.mme.saveScene().stageParams).toEqual({ [ch]: 4 });
    f.resetAll();
    expect('stageParams' in f.mme.saveScene()).toBe(false);
  });

  it('ポストエフェクトのパラメータの値はアクセサリの物の値 (同じ .fx のアクセサリが 2 つでも、それぞれのもの)', async () => {
    const e = new Engine();
    const fx = await e.mme.loadEffect([fileAt('P/post.fx', `float Strength < float UIMin = 0; float UIMax = 4; > = 1;
float4 VS(float4 p : POSITION) : POSITION { return p; }
float4 PS() : COLOR0 { return float4(Strength, 0, 0, 1); }
technique Post < string Script = "ScriptExternal=Color; Pass=P;"; > { pass P < string Script = "Draw=Buffer;"; > { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }`)], 'post.fx');
    e.mme.addPost(fx);
    const second = e.mme.addPost(fx)!;
    e.mme.setParam(second, fx.folder.id, 'post.fx', 'Strength', [2]);
    expect(e.mme.paramsOf(second)[0].params[0]).toMatchObject({ name: 'Strength', value: [2] });
    const r = e.mme.renderer as unknown as DrawInternals;
    const chain = new PostChain({
      fb: fakeFb() as never, instance: x => r.instance(x), render: () => {}, checkLink: () => {}, offscreen: () => null, control: () => null,
    });
    const frame = { camera: {}, light: {}, time: 0, elapsed: 0, selfShadow: false, screen: [320, 240], frameNo: 1 } as unknown as FrameState;
    expect(captureParam('Strength', () => chain.run(e.mme.posts(), frame, () => {}))).toEqual([1, 2]);
  });
  // --- サイドバーの「MME」のページ (値の欄) ---
  const POST_FX = `float Strength < float UIMin = 0; float UIMax = 4; > = 1;
float3 Col < string UIWidget = "Color"; > = {1, 0, 0};
float4 VS(float4 p : POSITION) : POSITION { return p; }
float4 PS() : COLOR0 { return float4(Col * Strength, 1); }
technique Post < string Script = "ScriptExternal=Color; Pass=P;"; > { pass P < string Script = "Draw=Buffer;"; > { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }`;

  it('値の欄: アクセサリは X〜Tr (値がなければ既定) と当てた .fx のパラメータ (成分ごとのチャンネル)。MME の物でもモデルでもない物は null', async () => {
    const e = new Engine();
    const box = e.world.addShape(0, 0, 0, 0);
    e.select(box);
    expect(e.ui.state.mme.values).toBeNull();
    const fx = await e.mme.loadEffect([fileAt('P/post.fx', POST_FX)], 'post.fx');
    const acc = e.mme.addPost(fx)!;
    e.select(acc);
    const v = e.ui.state.mme.values!;
    expect(v.objId).toBe(acc.id);
    expect(v.kind).toBe('accessory');
    expect(v.items).toEqual([['X', 0], ['Y', 0], ['Z', 0], ['Rx', 0], ['Ry', 0], ['Rz', 0], ['Si', 1], ['Tr', 1]].map(([name, value]) => ({ name, value })));
    const base = `${fx.folder.id}/post.fx`;
    expect(v.effects).toEqual([{
      effect: { folder: fx.folder.id, path: 'post.fx', name: 'P/post.fx' },
      params: [
        { name: 'Strength', label: 'Strength', type: 'float', init: [1], min: 0, max: 4, color: false, value: [1], channels: [`${base}:Strength`] },
        { name: 'Col', label: 'Col', type: 'float3', init: [1, 0, 0], min: 0, max: 2, color: true, value: [1, 0, 0], channels: ['x', 'y', 'z'].map(c => `${base}:Col:${c}`) },
      ],
    }]);
    e.select(null);
    expect(e.ui.state.mme.values).toBeNull();
  });

  it('setItem: アクセサリの X〜Tr (Si は 0 以上・Tr は 0〜1) とコントローラーの項目 (0〜1) を物に書き、値の欄に出す。元に戻すと、描き直す前でも値の欄が戻る', async () => {
    const e = new Engine();
    const acc = e.addMmeObject({ kind: 'accessory', name: 'a.x' });
    e.history.checkpoint();
    const edited = vi.spyOn(e.history, 'soon');
    e.mme.setItem(acc, 'Rx', 450);
    e.mme.setItem(acc, 'Si', -2);
    e.mme.setItem(acc, 'Tr', 3);
    e.mme.setItem(acc, 'Nope', 1); // (アクセサリの項目でない)
    e.mme.setItem(acc, 'X', Number.NaN);
    expect(acc.mmeValues).toMatchObject({ Rx: 450, Si: 0, Tr: 1, X: 0 });
    expect(acc.mmeValues).not.toHaveProperty('Nope');
    expect(acc.mmeChannels).toEqual(['Rx', 'Si', 'Tr']);
    expect(edited).toHaveBeenCalled();
    expect(e.ui.state.mme.values?.items.find(x => x.name === 'Rx')?.value).toBe(450);
    const ctl = e.addMmeObject({ kind: 'controller', name: 'ray_controller.pmx' });
    e.mme.setItem(ctl, 'SSAO+', 2);
    expect(ctl.mmeValues).toEqual({ 'SSAO+': 1 });
    expect(e.ui.state.mme.values?.items).toEqual([{ name: 'SSAO+', value: 1 }]); // (物のチャンネルも項目に並ぶ)
    const box = e.world.addShape(0, 0, 0, 0);
    e.mme.setItem(box, 'X', 1); // (MME の物でなければ何もしない)
    expect(box.mmeValues).toBeUndefined();
    // 元に戻す (標準のエンジンなので、描き直しの publish はない)
    e.select(acc);
    e.history.checkpoint();
    e.mme.setItem(acc, 'Tr', 0.5);
    expect(e.ui.state.mme.values?.items.find(x => x.name === 'Tr')?.value).toBe(0.5);
    e.history.checkpoint();
    await e.history.undo();
    expect(acc.mmeValues?.Tr).toBe(1);
    expect(e.ui.state.mme.values?.items.find(x => x.name === 'Tr')?.value).toBe(1);
  });

  it('toggleKey: いまのフレームにキーがなければ、値のないチャンネルに画面の値 (初期値) を入れてから打ち、あれば消す。hasKey', async () => {
    const e = new Engine();
    const fx = await e.mme.loadEffect([fileAt('P/post.fx', POST_FX)], 'post.fx');
    const acc = e.mme.addPost(fx)!;
    const chs = ['x', 'y', 'z'].map(c => `${fx.folder.id}/post.fx:Col:${c}`);
    e.clock.setRange(0, 10);
    e.clock.seekFrame(40);
    expect(e.mme.hasKey(acc, chs)).toBe(false);
    e.mme.toggleKey(acc, { [chs[0]]: 1, [chs[1]]: 0, [chs[2]]: 0 });
    expect(acc.mmeValues).toMatchObject({ [chs[0]]: 1, [chs[1]]: 0, [chs[2]]: 0 });
    expect(e.mme.hasKey(acc, chs)).toBe(true);
    expect(e.mme.hasKey(acc, chs, 0)).toBe(false);
    expect(e.clock.end).toBe(40); // (終わりのフレームを延ばす)
    expect(e.timelineRows(true)[0].keys).toEqual([40]);
    // 値のあるものは物の値のまま打つ
    e.mme.setItem(acc, 'Si', 2);
    e.mme.toggleKey(acc, { Si: 1 });
    expect(acc.mmeValues?.Si).toBe(2);
    expect([...acc.anim!.mme.get(acc.mmeChannels!.indexOf('Si'))!.values()].map(k => k.v)).toEqual([2]);
    // あれば消す (Col の 3 つ。Si は残る)
    e.mme.toggleKey(acc, { [chs[0]]: 1, [chs[1]]: 0, [chs[2]]: 0 });
    expect(e.mme.hasKey(acc, chs)).toBe(false);
    expect(e.mme.hasKey(acc, ['Si'])).toBe(true);
  });

  it('I (insertKey) は MME の物には値の欄の値の全部に打ち、位置・回転には打たない。位置の欄・Alt+G でも位置は変えない', async () => {
    const e = new Engine();
    const fx = await e.mme.loadEffect([fileAt('P/post.fx', POST_FX)], 'post.fx');
    const acc = e.mme.addPost(fx)!;
    e.select(acc);
    e.clock.seekFrame(5);
    e.insertKey();
    const names = (acc.mmeChannels ?? []).filter((_, i) => acc.anim?.mme.get(i)?.has(5));
    expect(names.sort()).toEqual(['X', 'Y', 'Z', 'Rx', 'Ry', 'Rz', 'Si', 'Tr', `${fx.folder.id}/post.fx:Strength`, ...['x', 'y', 'z'].map(c => `${fx.folder.id}/post.fx:Col:${c}`)].sort());
    expect(acc.anim?.props.size).toBe(0);
    e.setObjProp('x', 3);
    expect(acc.x).toBe(0);
    acc.x = 1; // (前の版で動かしてしまった物も、クリアで動かさない)
    e.clearTransform('location');
    expect(acc.x).toBe(1);
  });

  it('毎フレームの publish は、選んでいる物と値が変わらなければ値の欄を作り直さない。値が変われば作り直す', async () => {
    const e = new Engine();
    const fx = await e.mme.loadEffect([fileAt('P/post.fx', POST_FX)], 'post.fx');
    const acc = e.mme.addPost(fx)!;
    e.select(acc);
    e.mme.publish(); // (選んだあとの版の数の変化)
    const paramsOf = vi.spyOn(e.mme, 'paramsOf');
    const set = vi.spyOn(e.ui, 'set');
    for (let k = 0; k < 3; k++) e.mme.publish();
    expect(paramsOf).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    acc.mmeValues!.X = 2; // (キーフレームなどで物の値が変わった)
    e.mme.publish();
    expect(paramsOf).toHaveBeenCalledTimes(1);
    expect(e.ui.state.mme.values?.items[0]).toEqual({ name: 'X', value: 2 });
  });
});

// .emm (MME のエフェクト割当ファイル) の読み書き。書式は docs/superpowers/notes/2026-10-05-emm-format.md
describe('MmeEngine の .emm', () => {
  const crlf = (lines: string[]) => `${lines.join('\r\n')}\r\n`;
  const sjis = (lines: string[]) => encodeShiftJis(crlf(lines));
  afterEach(() => { vi.restoreAllMocks(); });
  // .pmx を読んだ MMD モデルの代わり (材質 n 個。骨も MMD のデータ (IK・付与) もないので、取り消しで置き直したときのポーズの計算
  // (Posing.solve。終わりを待たない) は止める)
  function model(e: Engine, file: string, n = 4) {
    vi.spyOn(e.posing, 'solve').mockResolvedValue(undefined);
    const mats = Array.from({ length: n }, () => new THREE.MeshBasicMaterial());
    const mesh = Object.assign(new THREE.Mesh(new THREE.BoxGeometry(), mats), { skeleton: new THREE.Skeleton([]) });
    mesh.userData.sourceFile = new File([], file);
    return e.world.addModel(mesh, 0, 0, []);
  }
  // フォルダ ray-mmd-1.5.2 (MaterialMap のオフスクリーンを宣言する ray.fx と、物・材質の .fx)
  const RAY_FX = 'texture MaterialMap : OFFSCREENRENDERTARGET < string DefaultEffect = "* = hide"; >;\ntechnique T { }';
  async function rayFolder(e: Engine) {
    const files = ['Main/main.fx', 'Materials/material_2.0.fx', 'Materials/Skin/material_skin.fx'].map(p => fileAt(`ray-mmd-1.5.2/${p}`, 'technique T { }'));
    const fx = await e.mme.loadEffect([fileAt('ray-mmd-1.5.2/ray.fx', RAY_FX), ...files], 'ray.fx');
    const at = (path: string) => ({ folder: fx.folder.id, path });
    return { fx, at };
  }

  it('importEmm: 名前で照らして割り当てを置き換え、場面にない .x はアクセサリを置く。場面にない物・読み込んでいない .fx は警告にまとめ、残りは当たる。1 回の取り消しで全部戻る', async () => {
    const e = new Engine();
    const { at } = await rayFolder(e);
    const miku = model(e, '初音ミク.pmx');
    const ray = e.addMmeObject({ kind: 'accessory', name: 'ray.x' });
    e.mme.assign(miku, 'Main', 2, 'hide'); // (.emm にないので外れる)
    e.history.checkpoint();
    const before = { objects: [...e.world.objects], miku: structuredClone(miku.mme), ray: ray.mme };
    const toast = vi.spyOn(e.ui, 'toast');
    const R = 'C:\\MMD\\ray-mmd-1.5.2';
    const result = e.mme.importEmm(sjis([
      '[Info]', 'Version = 3', '',
      '[Object]', 'Pmd1 = C:\\MMD\\UserFile\\Model\\初音ミク.pmx', `Acs2 = ${R}\\ray.x`, 'Pmd3 = D:\\Models\\Absent.pmx', 'Acs4 = C:\\MMD\\Extra\\glow.x', '',
      '[Effect]', 'Default = none', `Pmd1 = ${R}\\Main\\main.fx`, 'Pmd1[3].show = false', `Acs2 = ${R}\\ray.fx`, 'Pmd3 = none', 'Acs4 = C:\\MMD\\Extra\\glow.fx', '',
      '[Effect@MaterialMap]', 'Owner = Acs2', 'Acs2.show = false', `Pmd1 = ${R}\\materials\\material_2.0.fx`, `Pmd1[0] = ${R}\\Materials\\Skin\\material_skin.fx`,
      `Pmd1[1] = ${R}\\Materials\\missing.fx`, `Pmd3 = ${R}\\Materials\\material_2.0.fx`, '',
    ]));
    expect(miku.mme).toEqual({
      Main: { object: at('Main/main.fx'), materials: { 3: 'hide' } },
      MaterialMap: { object: at('Materials/material_2.0.fx'), materials: { 0: at('Materials/Skin/material_skin.fx') } },
    });
    expect(ray.mme).toEqual({ Main: { object: at('ray.fx') }, MaterialMap: { object: 'hide' } });
    const glow = e.world.objects[2];
    expect(e.world.objects).toEqual([miku, ray, glow]);
    expect([kindOf(glow), glow.mmeObj, glow.mme]).toEqual(['mme', { kind: 'accessory', name: 'glow.x' }, undefined]);
    expect(result).toEqual({
      applied: 6,
      warnings: [
        '.emm の物 Absent.pmx は場面にないので、その割り当てを飛ばしました',
        `.emm の .fx C:\\MMD\\Extra\\glow.fx・${R}\\Materials\\missing.fx は読み込んだフォルダにないので、その割り当てを飛ばしました`,
      ],
    });
    expect(toast).toHaveBeenCalledWith(`.emm を読みました (割り当て 6 件。${result.warnings.join('。')})`, 8000);
    // (1 回の取り消しで、置いたアクセサリも割り当ても戻る。やり直すとまた当たる)
    e.history.checkpoint();
    await e.history.undo();
    expect({ objects: e.world.objects, miku: miku.mme, ray: ray.mme }).toEqual(before);
    await e.history.redo();
    expect(e.world.objects).toEqual([miku, ray, glow]);
    expect(miku.mme?.Main?.object).toEqual(at('Main/main.fx'));
  });

  it('importEmm: 同じ名前の物は .emm の番号の順に場面の並びの順で当てる (大文字小文字は無視)。アクセサリの Main の行がなければ .x と同じ名前の .fx', async () => {
    const e = new Engine();
    const { at } = await rayFolder(e);
    const a = model(e, 'a.pmx'), b = model(e, 'A.pmx');
    const result = e.mme.importEmm(sjis([
      '[Object]', 'Pmd1 = x\\a.pmx', 'Pmd2 = y\\a.PMX', 'Acs3 = UserFile\\Effect\\ray-mmd-1.5.2\\ray.x', 'Acs4 = props\\plain.x', 'Acs5 = z\\ray.x',
      '[Effect]', 'Pmd1 = ray-mmd-1.5.2\\Main\\main.fx', 'Pmd2 = none', 'Pmd2[1] = ray-mmd-1.5.2\\Main\\main.fx', 'Acs5 = none',
    ]));
    expect(result.warnings).toEqual([]);
    expect(a.mme).toEqual({ Main: { object: at('Main/main.fx') } });
    expect(b.mme).toEqual({ Main: { materials: { 1: at('Main/main.fx') } } });
    const [, , ray, plain, ray2] = e.world.objects;
    expect([ray.mmeObj?.name, ray.mme]).toEqual(['ray.x', { Main: { object: at('ray.fx') } }]); // (MME が自動で読む .fx)
    expect([plain.mmeObj?.name, plain.mme]).toEqual(['plain.x', undefined]); // (.fx がなくても警告しない)
    expect([ray2.mmeObj?.name, ray2.mme]).toEqual(['ray.x', undefined]); // (none と書いてあれば当てない)
    expect(result.applied).toBe(3);
  });

  it('importEmm: ステージは .pmx のファイル名で照らし、割り当てを置き換える (場面の値なので取り消しの対象にしない)', async () => {
    const e = new Engine();
    const { at } = await rayFolder(e);
    const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(), [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()]);
    mesh.userData.sourceFile = new File([], 'Stage.pmx');
    const stage = new THREE.Group();
    stage.add(mesh);
    e.stage.model = stage;
    e.mme.assignStage('Other', null, 'hide'); // (.emm にないので外れる)
    e.history.checkpoint();
    const result = e.mme.importEmm(sjis(['[Object]', 'Pmd1 = UserFile\\Stage\\stage.pmx', '[Effect]', 'Pmd1 = ray-mmd-1.5.2\\Main\\main.fx', 'Pmd1[1].show = false']));
    expect(result).toEqual({ applied: 2, warnings: [] });
    const expected = { Main: { object: at('Main/main.fx'), materials: { 1: 'hide' } } };
    expect(e.mme.saveScene().stage).toEqual(expected);
    e.history.checkpoint();
    await e.history.undo();
    expect(e.mme.saveScene().stage).toEqual(expected);
  });

  it('importEmm: 置ける数を超えるアクセサリは置かずに警告 (同じ名前は 1 つ、多ければ数)。読めないファイルでも例外にならない', async () => {
    const e = new Engine();
    vi.spyOn(e.world, 'full', 'get').mockReturnValue(true);
    const accessories = ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) => `Acs${i + 1} = ${n}.x`);
    expect(e.mme.importEmm(sjis(['[Object]', ...accessories])).warnings).toEqual(['.emm のアクセサリ a.x・b.x・c.x・d.x・e.x ほか 2 件 を置けなかったので、その割り当てを飛ばしました (これ以上置けません)']);
    expect(e.world.objects).toEqual([]);
    expect(e.mme.importEmm(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toEqual({ applied: 0, warnings: ['.emm の 1 行目は読めないので飛ばしました'] });
  });

  it('exportEmm: いまの割り当てを MME の書式 (Shift_JIS・CRLF・フォルダの名前\\パス・Owner) にし、読み直すと同じ割り当てになる', async () => {
    const e = new Engine();
    const { fx, at } = await rayFolder(e);
    const miku = model(e, '初音ミク.pmx');
    e.world.addShape(0, 3, 0, 0); // (形は MMD にないので書かない)
    const ray = e.mme.addPost(fx)!;
    const ctl = e.addMmeObject({ kind: 'controller', name: 'ray_controller.pmx' });
    e.mme.assign(miku, 'Main', null, at('Main/main.fx'));
    e.mme.assign(miku, 'Main', 3, 'hide');
    e.mme.assign(miku, 'MaterialMap', 0, at('Materials/Skin/material_skin.fx'));
    e.mme.assign(ray, 'MaterialMap', null, 'hide');
    const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    mesh.userData.sourceFile = new File([], 'Stage.pmx');
    e.stage.model = new THREE.Group().add(mesh);
    e.mme.assignStage('MaterialMap', null, at('Materials/material_2.0.fx'));
    const bytes = e.mme.exportEmm();
    expect(bytes).toEqual(encodeShiftJis(new TextDecoder('shift_jis').decode(bytes))); // (Shift_JIS)
    expect(new TextDecoder('shift_jis').decode(bytes)).toBe(crlf([
      '[Info]', 'Version = 3', '',
      '[Object]', 'Pmd1 = 初音ミク.pmx', 'Acs2 = ray.x', 'Pmd3 = ray_controller.pmx', 'Pmd4 = Stage.pmx', '',
      '[Effect]', 'Default = none',
      'Pmd1 = ray-mmd-1.5.2\\Main\\main.fx', 'Pmd1[3] = none', 'Pmd1[3].show = false', 'Acs2 = ray-mmd-1.5.2\\ray.fx', 'Pmd3 = none', 'Pmd4 = none', '',
      '[Effect@MaterialMap]', 'Owner = Acs2',
      'Pmd1[0] = ray-mmd-1.5.2\\Materials\\Skin\\material_skin.fx', 'Acs2 = none', 'Acs2.show = false', 'Pmd4 = ray-mmd-1.5.2\\Materials\\material_2.0.fx', '',
    ]));
    // (外してから読み直すと同じ)
    const saved = { miku: structuredClone(miku.mme), ray: structuredClone(ray.mme), stage: e.mme.saveScene().stage };
    e.mme.clearEffects();
    expect(e.mme.importEmm(bytes)).toEqual({ applied: 6, warnings: [] });
    expect({ miku: miku.mme, ray: ray.mme, stage: e.mme.saveScene().stage }).toEqual(saved);
    expect([ctl.mme, e.world.objects.length]).toEqual([undefined, 4]);
  });
});
