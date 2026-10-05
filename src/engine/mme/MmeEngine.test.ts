import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../Engine';
import { convertMmdMesh } from '../materials/fromMmd';
import { EffectInstance } from './EffectInstance';
import { MME_DEFAULTS, normalizeMme } from './MmeEngine';

// フォルダから選んだファイル (webkitRelativePath は 'フォルダ/…')
function fileAt(path: string, text: string): File {
  const f = new File([text], path.slice(path.lastIndexOf('/') + 1));
  Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
}

// 描画先なしで、レンダーエンジンの切り替えと Viewport.drawOverride の差し替えを確かめる
describe('MmeEngine', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('既定の設定', () => {
    expect(MME_DEFAULTS).toEqual({ engine: 'standard', selfShadow: true, shadowDistance: 8875, groundShadow: true });
    expect(new Engine().mme.settings).toEqual(MME_DEFAULTS);
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

  it('物を消すと、その物の .fx の割り当ても消える', async () => {
    const e = new Engine();
    const obj = e.world.addShape(0, 0, 0, 0);
    const fx = await e.mme.loadEffect([new File(['technique T { }'], 'a.fx')], 'a.fx');
    e.mme.store.setObjectEffect(obj.id, fx);
    expect(e.mme.store.objectEffect(obj.id)).toBe(fx);
    e.world.remove(obj);
    expect(e.mme.store.objectEffect(obj.id)).toBeNull();
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
    effectOf(obj: unknown): unknown;
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
    e.mme.store.setObjectEffect(obj.id, fx);
    const r = e.mme.renderer as unknown as Internals;
    expect(r.effectOf(obj)).toBe(fx);
    r.instance(fx).stopped = true;
    expect(r.effectOf(obj)).toBe(e.mme.store.defaultEffect);
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
      expect(json.mme).toEqual(MME_DEFAULTS);
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
    expect(e.ui.state.mme).toEqual({ settings: MME_DEFAULTS, object: null, posts: [], warnings: [] });
    e.mme.set({ engine: 'mme' });
    expect(e.ui.state.mme.settings.engine).toBe('mme');
    const obj = e.world.addShape(0, 0, 0, 0);
    e.selection.select(obj);
    const good = await e.mme.loadEffect([fileAt('Fx/good.fx', 'technique T { }')], 'good.fx');
    const bad = await e.mme.loadEffect([fileAt('Fx/bad.fx', 'float4 x = ;')], 'bad.fx');
    e.mme.store.setObjectEffect(obj.id, bad);
    const object = e.ui.state.mme.object!;
    expect(object).toMatchObject({ name: 'Fx/bad.fx', ok: false, warnings: [] });
    expect(object.errors.length).toBeGreaterThan(0);
    expect(object.errors[0]).toEqual({ code: expect.stringMatching(/^FX-/), where: 'bad.fx:1', message: expect.any(String) });
    e.selection.select(null);
    expect(e.ui.state.mme.object).toBeNull();
    e.selection.select(obj);
    e.mme.store.setObjectEffect(obj.id, null);
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
    expect(e.mme.store.objectEffect(obj.id)).toBeNull();
    e.selection.select(obj);
    const loading = e.mme.loadObjectEffect(files(), 'a.fx');
    e.selection.select(null); // 読んでいるあいだに選び直しても、押したときの物に当てる
    await loading;
    expect(e.mme.store.objectEffect(obj.id)?.name).toBe('Fx/a.fx');
    e.selection.select(obj);
    expect(e.ui.state.mme.object?.name).toBe('Fx/a.fx');
    e.mme.removeObjectEffect();
    expect(e.mme.store.objectEffect(obj.id)).toBeNull();
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
    expect(e.mme.store.objectEffect(obj.id)).toBeNull();
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
    const assign = () => { e.mme.store.setObjectEffect(obj.id, fx); e.mme.store.addPost(fx); };
    assign();
    e.resetAll();
    expect(e.mme.store.objectEffect(obj.id)).toBeNull();
    expect(e.mme.store.posts).toEqual([]);
    expect(e.ui.state.mme.posts).toEqual([]);
    // プロジェクトを開いても (開く前に最初の状態に戻す)
    const bytes = await e.project.save('reference');
    assign();
    await e.project.open(bytes);
    expect(e.mme.store.posts).toEqual([]);
    expect(e.mme.store.objectEffect(obj.id)).toBeNull();
  });
});
