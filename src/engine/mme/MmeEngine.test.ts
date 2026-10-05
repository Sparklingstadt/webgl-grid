import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../Engine';
import { convertMmdMesh } from '../materials/fromMmd';
import { parseDefaultEffect } from '../../core/mme/defaultEffect.ts';
import { EffectInstance } from './EffectInstance';
import type { LoadedEffect } from './EffectStore';
import { readEmbedded } from '../project/format';
import { MME_DEFAULTS, normalizeMme } from './MmeEngine';

// フォルダから選んだファイル (webkitRelativePath は 'フォルダ/…')
function fileAt(path: string, text: string): File {
  const f = new File([text], path.slice(path.lastIndexOf('/') + 1));
  Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
}
// 読み込んだ .fx を指す割り当て
const ref = (e: LoadedEffect) => ({ folder: e.folder.id, path: e.entry });

// 描画先なしで、レンダーエンジンの切り替えと Viewport.drawOverride の差し替えを確かめる
describe('MmeEngine', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('既定の設定', () => {
    expect(MME_DEFAULTS).toEqual({ engine: 'standard', selfShadow: true, shadowDistance: 8875, groundShadow: true });
    expect(new Engine().mme.settings).toEqual(MME_DEFAULTS);
  });

  it('setControl は仮のコントローラーの値を (0〜1 に収めて) 入れ、描き直す。元に戻すの手にはしない', () => {
    const e = new Engine();
    const draw = vi.spyOn(e.viewport, 'requestDraw');
    const edited = vi.spyOn(e.history, 'soon');
    e.mme.setControl('ray_controller.pmx', 'SSAO+', 3);
    expect(e.mme.controllers.values.get('ray_controller.pmx')?.get('SSAO+')).toBe(1);
    expect(draw).toHaveBeenCalled();
    expect(edited).not.toHaveBeenCalled();
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
    expect(r.mainSlot(b, b.mesh!, 0)).toEqual({ kind: 'effect', effect: fx });
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
    expect(r.mainSlot(obj, obj.mesh!, 0)).toEqual({ kind: 'effect', effect: fx });
    r.instance(fx).stopped = true;
    // (そのフレームのうちは変えない。次のフレームから default.fx)
    expect(r.mainSlot(obj, obj.mesh!, 0)).toEqual({ kind: 'effect', effect: fx });
    r.mainSlots.clear();
    expect(r.mainSlot(obj, obj.mesh!, 0)).toEqual({ kind: 'effect', effect: e.mme.store.defaultEffect });
    expect(e.mme.renderer.stopped(fx)).toBe(true);
  });

  it('ポストエフェクトの資源は、一覧にあるあいだ捨てず (オフでも)、外すと捨てる。whenReady はオンのポストエフェクトのテクスチャも待つ', async () => {
    const e = new Engine();
    const fx = await e.mme.loadEffect([new File(['technique T { }'], 'post.fx')], 'post.fx');
    const r = e.mme.renderer as unknown as Internals;
    const ready = vi.spyOn(EffectInstance.prototype, 'ready');
    e.mme.store.addPost(fx);
    await e.mme.whenReady();
    const inst = r.instance(fx);
    expect(ready.mock.contexts).toContain(inst);
    const dispose = vi.spyOn(inst as unknown as EffectInstance, 'dispose');
    e.mme.store.setPostEnabled(0, false); // (changed で prune される)
    expect(dispose).not.toHaveBeenCalled();
    e.mme.store.removePost(0);
    expect(dispose).toHaveBeenCalledTimes(1);
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
    e.mme.store.addPost(fx);
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
    expect(e.ui.state.mme).toEqual({ settings: MME_DEFAULTS, object: null, posts: [], warnings: [], folders: [], tabs: [{ name: 'Main', description: '' }], rows: { Main: [] }, controllers: [] });
    e.mme.set({ engine: 'mme' });
    expect(e.ui.state.mme.settings.engine).toBe('mme');
    const obj = e.world.addShape(0, 0, 0, 0);
    e.selection.select(obj);
    const good = await e.mme.loadEffect([fileAt('Fx/good.fx', 'technique T { }')], 'good.fx');
    const bad = await e.mme.loadEffect([fileAt('Fx/bad.fx', 'float4 x = ;')], 'bad.fx');
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

    e.mme.store.addPost(good);
    e.mme.store.setPostEnabled(0, false);
    expect(e.ui.state.mme.posts).toEqual([{ id: good.id, name: 'Fx/good.fx', ok: true, errors: [], errorCount: 0, warnings: [], enabled: false }]);
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
    // 仮のコントローラー: 描いているエフェクトの、場面にない名前の float の項目と値
    e.mme.assign(obj, 'Main', null, { folder: good.folder.id, path: 'sub/ctl.fx' });
    expect(fallbackFor).toHaveBeenCalled(); // (割り当てが変わったので作り直した)
    expect(e.ui.state.mme.controllers).toEqual([{ name: 'ray_controller.pmx', items: [{ item: 'Red', value: 0 }] }]);
    e.mme.setControl('RAY_CONTROLLER.pmx', 'Red', 0.25);
    expect(e.ui.state.mme.controllers).toEqual([{ name: 'ray_controller.pmx', items: [{ item: 'Red', value: 0.25 }] }]);
  });

  it('毎フレームの publish は、元 (割り当て・物・名前・マテリアル・フォルダ・タブ・止めたエフェクト) が変わらなければ物の材質やエフェクトを集め直さない', async () => {
    const e = new Engine();
    const obj = e.world.addShape(0, 0, 0, 0);
    const good = await e.mme.loadEffect([fileAt('Fx/good.fx', 'technique T { }')], 'good.fx');
    e.mme.set({ engine: 'mme' });
    vi.spyOn(e.mme.renderer, 'render').mockReturnValue(true);
    const materialNames = vi.spyOn(e.mme as unknown as { materialNames(o: unknown): string[] }, 'materialNames');
    const drawnEffects = vi.spyOn(e.mme.renderer, 'drawnEffects');
    const rebuilt = () => {
      const n = [materialNames.mock.calls.length, drawnEffects.mock.calls.length];
      materialNames.mockClear();
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
    e.mme.store.addPost(fx);
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
    expect(e.ui.state.mme.posts.map(p => [p.name, p.enabled])).toEqual([['P/post.fx', true]]);
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
    await expect(e.mme.addPostEffect([broken], 'a.fx')).resolves.toBeUndefined();
    expect(e.ui.state.toast?.text).toContain('読めない');
    expect(e.mme.store.posts).toEqual([]);
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
    const assign = () => { e.mme.assign(obj, 'Main', null, ref(fx)); e.mme.store.addPost(fx); };
    assign();
    e.mme.clearEffects(); // (場面にある物の割り当ても外す)
    expect(obj.mme).toBeUndefined();
    expect(e.mme.store.posts).toEqual([]);
    assign();
    e.resetAll();
    expect(e.mme.store.posts).toEqual([]);
    expect(e.ui.state.mme.posts).toEqual([]);
    // プロジェクトを開いても (開く前に最初の状態に戻す)
    const shape = e.world.addShape(0, 0, 0, 0);
    const bytes = await e.project.save('reference');
    e.mme.assign(shape, 'Main', null, ref(fx));
    e.mme.store.addPost(fx);
    await e.project.open(bytes);
    expect(e.mme.store.posts).toEqual([]);
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
  async function buildMmeScene(e: Engine) {
    const obj = e.world.addShape(0, 0, 0, 0);
    const a = await e.mme.loadEffect(fxFolder(), 'a.fx');
    e.mme.assign(obj, 'Main', null, ref(a));
    e.mme.store.addPost(e.mme.store.effect(a.folder, 'post.fx'));
    e.mme.store.setPostEnabled(0, false);
    e.mme.setControl('Ctrl', 'Si', 0.7);
    e.mme.set({ engine: 'mme', selfShadow: false });
    return a.folder.id;
  }
  async function expectMmeScene(e: Engine, id: string) {
    expect(e.mme.store.folders().map(f => [f.id, f.name, [...f.files.keys()].sort()])).toEqual([[id, 'Fx', ['a.fx', 'post.fx', 'tex.png']]]);
    const folder = e.mme.store.folder(id)!;
    expect(await textOf(folder.files.get('a.fx'))).toBe(TEX_FX('tex.png'));
    expect(new Uint8Array(await folder.files.get('tex.png')!.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    expect(e.mme.store.posts.map(p => [p.effect.folder.id, p.effect.entry, p.effect.result.ok, p.enabled])).toEqual([[id, 'post.fx', true, false]]);
    expect(e.mme.controllers.get('Ctrl', 'Si')).toBeCloseTo(0.7, 6);
    expect(e.mme.settings).toMatchObject({ engine: 'mme', selfShadow: false });
    const [obj] = e.world.objects;
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
      posts: [{ effect: { folder: id, path: 'post.fx' }, enabled: false }], controls: { Ctrl: { Si: 0.7 } },
    });
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
    expect(f.mme.store.posts.map(p => [p.effect.entry, p.effect.result.ok])).toEqual([['post.fx', false]]);
    // 保存し直しても、ポストエフェクトの参照は残る
    const again = JSON.parse(new TextDecoder().decode(await f.project.save('reference')));
    expect(again.mme.posts).toEqual([{ effect: { folder: id, path: 'post.fx' }, enabled: false }]);
  });

  it('保存の前に、ポストエフェクトのオフスクリーンの DefaultEffect で描く .fx とその画像も (まだ描いていなくても) 読んだファイルにする', async () => {
    const e = new Engine();
    e.world.addShape(0, 0, 0, 0);
    const post = await e.mme.loadEffect([fileAt('P/post.fx', OFF_POST('*=sub/off.fx;')), fileAt('P/sub/off.fx', TEX_FX('off.png')), bin('P/sub/off.png', [1])], 'post.fx');
    e.mme.store.addPost(post);
    const { data } = await readEmbedded(await e.project.save('embedded'));
    expect((data.mmeFiles as { path: string }[]).map(m => m.path)).toEqual(['post.fx', 'sub/off.fx', 'sub/off.png']);
    // (画像は読まず、標準のエンジンのあいだは MME の資源を作らない)
    expect((e.mme.renderer as unknown as Internals).instances.size).toBe(0);
  });

  it('whenReady (書き出しの前) も、オフスクリーンの DefaultEffect で描く .fx の画像を、まだ描いていなくても待つ。オフのポストエフェクトのものは待たない', async () => {
    const e = new Engine();
    const on = await e.mme.loadEffect([fileAt('On/post.fx', OFF_POST('*=off.fx;')), fileAt('On/off.fx', TEX_FX('on.png')), bin('On/on.png', [1])], 'post.fx');
    const off = await e.mme.loadEffect([fileAt('Off/post.fx', OFF_POST('*=off.fx;')), fileAt('Off/off.fx', TEX_FX('off.png')), bin('Off/off.png', [2])], 'post.fx');
    e.mme.store.addPost(on);
    e.mme.store.addPost(off);
    e.mme.store.setPostEnabled(1, false);
    await e.mme.whenReady();
    expect([...on.folder.used].sort()).toEqual(['off.fx', 'on.png', 'post.fx']);
    expect([...off.folder.used].sort()).toEqual(['post.fx']);
  });

  it('used にあってフォルダにないパスは保存しない (例外にならない)', async () => {
    const e = new Engine();
    const fx = await e.mme.loadEffect([fileAt('Fx/a.fx', 'technique T { }')], 'a.fx');
    e.mme.store.addPost(fx);
    fx.folder.used.add('ghost.png');
    const { data } = await readEmbedded(await e.project.save('embedded'));
    expect((data.mmeFiles as { path: string }[]).map(m => m.path)).toEqual(['a.fx']);
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

  it('最初の状態に戻すと、フォルダ・仮のコントローラーの値・ポストエフェクト・割り当て・設定を消す', async () => {
    const e = new Engine();
    await buildMmeScene(e);
    e.resetAll();
    expect(e.mme.store.folders()).toEqual([]);
    expect(e.mme.controllers.values.size).toBe(0);
    expect(e.mme.store.posts).toEqual([]);
    expect(e.mme.settings).toEqual(MME_DEFAULTS);
    expect(e.ui.state.mme.folders).toEqual([]);
  });
});
