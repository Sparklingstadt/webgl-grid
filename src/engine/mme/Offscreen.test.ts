import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { compileEffect } from '../../core/fx/index.ts';
import { corpusFrom } from '../../core/fx/testing/rayCorpus.ts';
import type { TargetSpec } from '../../core/mme/targets.ts';
import type { Obj } from '../types';
import type { UiChannel } from '../UiChannel';
import { Assignments } from './Assignments';
import { EffectStore, type LoadedEffect } from './EffectStore';
import { CANVAS, type ColorTarget, type Surface } from './Framebuffers';
import { Offscreen, offscreenDecls, type OffscreenDeps, type OffscreenUse } from './Offscreen';
import type { FrameState } from './PostChain';
import type { PassTable } from './ScenePass';

// Ray-MMD 1.5.2 の .fx・.fxsub・.conf (third_party/ray-mmd-1.5.2 をルートにする)
const PREFIX = '../../../third_party/ray-mmd-1.5.2/';
const raw = import.meta.glob('../../../third_party/ray-mmd-1.5.2/**/*.{fx,fxsub,conf}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const ray = corpusFrom(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.slice(PREFIX.length), v])));

// フォルダから選んだファイル (webkitRelativePath は 'フォルダ/…')
function fileAt(path: string, text: string): File {
  const f = new File([text], path.slice(path.lastIndexOf('/') + 1));
  Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
}

const SCREEN: [number, number] = [320, 240];
const frameOf = (frameNo: number) => ({ frameNo, screen: SCREEN } as FrameState);
const obj = (id: number) => ({ id, s: 0, name: `物${id}` } as unknown as Obj);

// 宣言だけの .fx (technique は空)
const offscreenFx = (decls: string) => `${decls}\ntechnique T { }`;
const decl = (name: string, annotations = '', shared = false) =>
  `${shared ? 'shared ' : ''}texture ${name} : OFFSCREENRENDERTARGET < ${annotations} >;\nsampler ${name}Samp = sampler_state { texture = <${name}>; };`;

async function load(files: Record<string, string>) {
  const store = new EffectStore({ toast: vi.fn() } as unknown as UiChannel);
  const folder = await store.addFolder(Object.entries(files).map(([p, text]) => fileAt(`fx/${p}`, text)));
  return { store, fx: (p: string) => store.effect(folder, p) };
}

// three.js の代わりの小さな deps: 描画先を替える・消す・場面を描くのを log に書く
function harness(store: EffectStore, uses: (table: PassTable) => OffscreenUse[] = () => []) {
  const log: string[] = [];
  const warnings: string[] = [];
  const stopped = new Set<LoadedEffect>();
  const label = (s: Surface) => (s.kind === 'targets' ? s.colors[0]!.name : s.kind);
  const fb = {
    current: CANVAS as Surface,
    defaultSurface: CANVAS as Surface,
    bindSurface: (s: Surface) => { fb.current = s; return { flipY: -1 as const, size: [1, 1] as [number, number] }; },
    clear: (color: number[] | null, depth: number | null, stencil: number | null) => { log.push(`clear ${label(fb.current)} ${JSON.stringify([color, depth, stencil])}`); },
    offscreenTarget: (key: string, _effect: LoadedEffect, name: string, spec: TargetSpec) => ({
      target: { kind: 'color', name: `${name}(${key})`, width: spec.width, height: spec.height, format: spec.format, tex: new THREE.Texture() } as unknown as ColorTarget,
      warnings: [],
    }),
    offscreenSurface: (t: ColorTarget): Surface => ({ kind: 'targets', colors: [t], depth: null }),
    dropOffscreen: (key: string) => { log.push(`drop ${key}`); },
  };
  const assignments = new Assignments(store, m => warnings.push(m));
  const deps: OffscreenDeps = {
    fb: () => fb,
    scene: {
      draw: (table, _frame, _target) => {
        log.push(`draw ${table.name} → ${label(fb.current)} (default ${label(fb.defaultSurface)})`);
      },
      uses,
    },
    slotFor: (tab, defaults, owner) => assignments.slotFor(tab, defaults, owner),
    prepare: e => { log.push(`prepare ${e.entry}`); },
    stopped: e => stopped.has(e),
    warn: (m, e) => warnings.push(e ? `${e.name}: ${m}` : m),
  };
  return { log, warnings, stopped, fb, offscreen: new Offscreen(deps) };
}

const draws = (log: string[]) => log.filter(l => l.startsWith('draw ')).map(l => l.split(' ')[1]);

describe('offscreenDecls', () => {
  it('Ray-MMD の ray.fx: MaterialMap (textures.fxsub の宣言) の名前・形式・大きさ・shared・DefaultEffect の規則の数', () => {
    const result = compileEffect('ray.fx', p => ray.readFile(p), { listFiles: () => ray.listFiles() });
    if (!result.ok) throw new Error(result.errors[0]?.message);
    const effect = { id: 'fx1', name: 'ray.fx', entry: 'ray.fx', result } as LoadedEffect;
    const { decls, warnings } = offscreenDecls(effect, [1280, 720]);
    expect(warnings).toEqual([]);
    const m = decls.find(d => d.name === 'MaterialMap')!;
    expect(m).toMatchObject({
      effect, name: 'MaterialMap', shared: true, width: 1280, height: 720, format: 'rgba8', clearColor: [0, 0, 0, 0], clearDepth: 1,
      antiAlias: false, mipLevels: 1, description: 'Material cache map for ray', draws: true,
    });
    expect(m.rules.length).toBe(12);
    expect(m.rules[0]).toEqual({ pattern: 'self', action: { kind: 'hide' } });
    expect(m.rules[9]).toEqual({ pattern: '*.pmx', action: { kind: 'effect', path: 'materials/material_2.0.fx' } });
    // 宣言の順 (LightMap は MaterialMap より先)
    const names = decls.map(d => d.name);
    expect(names.indexOf('LightMap')).toBeLessThan(names.indexOf('MaterialMap'));
    // gbuffer_sampler.fxsub の注釈のない shared の宣言は、ほかのエフェクトが描くものを読むだけ
    const reader = compileEffect('r.fx', p => (p === 'r.fx' ? new TextEncoder().encode(offscreenFx(decl('MaterialMap', '', true))) : null));
    if (!reader.ok) throw new Error(reader.errors[0]?.message);
    expect(offscreenDecls({ ...effect, result: reader }, SCREEN).decls[0]).toMatchObject({ shared: true, draws: false, width: 320, height: 240, rules: [] });
  });

  it('Dimensions・形式・MipLevels・AntiAlias (対応しないので警告)・壊れた DefaultEffect の項 (警告)', async () => {
    const { fx } = await load({
      'a.fx': offscreenFx(decl('A', 'int2 Dimensions = {64, 32}; string Format = "R32F"; int MipLevels = 0; bool AntiAlias = true; float4 ClearColor = {1, 0.5, 0, 1}; float ClearDepth = 0.25; string DefaultEffect = "self = hide; broken; * = b.fx;";')),
    });
    const { decls, warnings } = offscreenDecls(fx('a.fx'), SCREEN);
    expect(decls[0]).toMatchObject({ width: 64, height: 32, format: 'r32f', mipLevels: 0, antiAlias: true, clearColor: [1, 0.5, 0, 1], clearDepth: 0.25, shared: false, draws: true });
    expect(decls[0].rules.map(r => r.pattern)).toEqual(['self', '*']);
    expect(warnings).toEqual([
      'A: DefaultEffect の項 "broken" に = がないので無視します',
      'オフスクリーン A の AntiAlias には対応していないので、アンチエイリアスなしで描きます',
    ]);
  });
});

describe('Offscreen', () => {
  it('宣言 A・B の順のエフェクトは B → A の順に描く。同じフレームで 2 回 ensure しても 1 回だけ。次のフレームはまた描く', async () => {
    const { store, fx } = await load({ 'e.fx': offscreenFx(decl('A', 'string DefaultEffect = "* = hide;";') + decl('B', 'string DefaultEffect = "* = hide;";')) });
    const h = harness(store);
    const e = fx('e.fx');
    h.offscreen.begin(1);
    h.offscreen.ensure(e, null, frameOf(1));
    h.offscreen.ensure(e, null, frameOf(1));
    expect(draws(h.log)).toEqual(['B', 'A']);
    h.offscreen.begin(2);
    h.offscreen.ensure(e, null, frameOf(2));
    expect(draws(h.log)).toEqual(['B', 'A', 'B', 'A']);
  });

  it('宣言の警告は宣言を読んだときに 1 回出し、declWarnings で後からも引ける (dispose で忘れる)', async () => {
    const { store, fx } = await load({ 'e.fx': offscreenFx(decl('A', 'bool AntiAlias = true; string DefaultEffect = "* = hide;";')) });
    const h = harness(store);
    const e = fx('e.fx');
    const warning = 'オフスクリーン A の AntiAlias には対応していないので、アンチエイリアスなしで描きます';
    expect(h.offscreen.declWarnings(e)).toEqual([]);
    for (const n of [1, 2]) {
      h.offscreen.begin(n);
      h.offscreen.ensure(e, null, frameOf(n));
    }
    expect(h.warnings).toEqual([`fx/e.fx: ${warning}`]);
    expect(h.offscreen.declWarnings(e)).toEqual([warning]);
    h.offscreen.dispose();
    expect(h.offscreen.declWarnings(e)).toEqual([]);
  });

  it('描く前に ClearColor・ClearDepth (とステンシル 0) で消し、オフスクリーンを既定の描画先にして描き、終わったら元の描画先に戻す', async () => {
    const { store, fx } = await load({ 'e.fx': offscreenFx(decl('A', 'float4 ClearColor = {0, 0, 1, 1}; float ClearDepth = 0.5;')) });
    const h = harness(store);
    const outer: Surface = { kind: 'targets', colors: [{ name: 'Outer' } as ColorTarget], depth: null };
    h.fb.current = outer;
    h.fb.defaultSurface = CANVAS;
    h.offscreen.begin(1);
    h.offscreen.ensure(fx('e.fx'), null, frameOf(1));
    expect(h.log).toEqual([
      `clear A(${fx('e.fx').id}|A|) [[0,0,1,1],0.5,0]`,
      `draw A → A(${fx('e.fx').id}|A|) (default canvas)`,
    ]);
    expect([h.fb.current, h.fb.defaultSurface]).toEqual([outer, CANVAS]);
    expect(h.offscreen.texture(fx('e.fx'), 'A', null)).toBeInstanceOf(THREE.Texture);
    expect(h.offscreen.texture(fx('e.fx'), 'Nope', null)).toBeNull();
  });

  it('入れ子: 表で描く物のエフェクトのオフスクリーンを先に描き (持ち主はその物)、その前にレンダーターゲットを用意する。3 段目は警告して描かない', async () => {
    const { store, fx } = await load({
      'post.fx': offscreenFx(decl('Outer', 'string DefaultEffect = "* = light.fx;";')),
      'light.fx': offscreenFx(decl('Shadow', 'string DefaultEffect = "* = deep.fx;";')),
      'deep.fx': offscreenFx(decl('Deeper', 'string DefaultEffect = "* = hide;";')),
    });
    const lamp = obj(7), doll = obj(8);
    const tables: PassTable[] = [];
    const h = harness(store, table => {
      tables.push(table);
      if (table.name === 'Outer') return [{ obj: lamp, effect: fx('light.fx') }];
      if (table.name === 'Shadow') return [{ obj: doll, effect: fx('deep.fx') }];
      return [];
    });
    h.offscreen.begin(1);
    h.offscreen.ensure(fx('post.fx'), null, frameOf(1));
    expect(draws(h.log)).toEqual(['Shadow', 'Outer']);
    expect(h.log.filter(l => l.startsWith('prepare'))).toEqual(['prepare light.fx', 'prepare deep.fx']);
    expect(tables.map(t => [t.name, t.owner])).toEqual([['Outer', null], ['Shadow', lamp]]);
    expect(h.warnings).toEqual(['fx/deep.fx: オフスクリーン Deeper は入れ子の 3 段目なので描きません (2 段まで)']);
    // 入れ子のものは持ち主ごと
    expect(h.offscreen.texture(fx('light.fx'), 'Shadow', lamp)).toBeInstanceOf(THREE.Texture);
    expect(h.offscreen.texture(fx('light.fx'), 'Shadow', doll)).toBeNull();
    expect(h.offscreen.effects()).toEqual(new Set([fx('post.fx'), fx('light.fx'), fx('deep.fx')]));
  });

  it('shared でないものは (エフェクト・名前・持ち主) ごと、shared のものは名前ごとに 1 つ。DefaultEffect のない shared の宣言は描かずに読む', async () => {
    const { store, fx } = await load({
      'own.fx': offscreenFx(decl('Own', 'string DefaultEffect = "* = hide;";')),
      'ray.fx': offscreenFx(decl('Map', 'string DefaultEffect = "* = hide;";', true)),
      'mat.fx': offscreenFx(decl('Map', '', true)),
    });
    const h = harness(store);
    const a = obj(1), b = obj(2);
    h.offscreen.begin(1);
    h.offscreen.ensure(fx('mat.fx'), a, frameOf(1)); // (読むだけ)
    expect(draws(h.log)).toEqual([]);
    h.offscreen.ensure(fx('own.fx'), a, frameOf(1));
    h.offscreen.ensure(fx('own.fx'), b, frameOf(1));
    h.offscreen.ensure(fx('ray.fx'), null, frameOf(1));
    expect(draws(h.log)).toEqual(['Own', 'Own', 'Map']);
    const own = (o: Obj) => h.offscreen.texture(fx('own.fx'), 'Own', o);
    expect(own(a)).not.toBe(own(b));
    expect(h.offscreen.texture(fx('mat.fx'), 'Map', a)).toBe(h.offscreen.texture(fx('ray.fx'), 'Map', null));
  });

  it('表: 割り当て → DefaultEffect (パスは宣言したエフェクトのフォルダから)。止めたエフェクトは hide にして警告を 1 回。self は持ち主', async () => {
    const { store, fx } = await load({
      'sub/light.fx': offscreenFx(decl('Shadow', 'string DefaultEffect = "self = hide; * = ../shade.fx;";')),
      'shade.fx': 'technique T { }',
      'other.fx': 'technique T { }',
    });
    const lamp = obj(1), doll = obj(2), cube = obj(3);
    const meshes = [new THREE.Mesh(), new THREE.Mesh(), new THREE.Mesh()]; // (表はメッシュ・材質ごとにフレームのあいだ覚える)
    cube.mme = { Shadow: { object: { folder: fx('shade.fx').folder.id, path: 'other.fx' } } };
    const seen: (string | null)[][] = [];
    const h = harness(store);
    const deps = (h.offscreen as unknown as { d: OffscreenDeps }).d;
    deps.scene.draw = table => {
      for (let k = 0; k < 2; k++) seen.push([lamp, doll, cube].map((o, i) => { const s = table.slotFor(o, meshes[i], 0); return s.kind === 'hide' ? 'hide' : s.effect.entry; }));
    };
    h.offscreen.begin(1);
    h.offscreen.ensure(fx('sub/light.fx'), lamp, frameOf(1));
    expect(seen[0]).toEqual(['hide', 'shade.fx', 'other.fx']);
    // 止めると、次のフレームから hide (警告は 1 回)
    h.stopped.add(fx('shade.fx'));
    h.offscreen.begin(2);
    h.offscreen.ensure(fx('sub/light.fx'), lamp, frameOf(2));
    expect(seen[2]).toEqual(['hide', 'hide', 'other.fx']);
    expect(seen[3]).toEqual(seen[2]);
    expect(h.warnings).toEqual(['fx/shade.fx を止めたので、オフスクリーン Shadow では描きません']);
    // 止めたエフェクトが宣言するものは描かない
    h.stopped.add(fx('sub/light.fx'));
    h.offscreen.begin(3);
    h.offscreen.ensure(fx('sub/light.fx'), lamp, frameOf(3));
    expect(seen.length).toBe(4);
  });

  it('tabs: 使ったエフェクトが宣言するオフスクリーンの名前と Description (名前ごとに 1 つ)。前のフレームで使わなかったターゲットは次のフレームの初めに捨てる', async () => {
    const { store, fx } = await load({
      'ray.fx': offscreenFx(decl('Map', 'string Description = "材質"; string DefaultEffect = "* = hide;";', true) + decl('Fog', 'string Description = "霧";')),
      'mat.fx': offscreenFx(decl('Map', '', true)),
    });
    const h = harness(store);
    h.offscreen.begin(1);
    h.offscreen.ensure(fx('mat.fx'), null, frameOf(1));
    h.offscreen.ensure(fx('ray.fx'), null, frameOf(1));
    expect(h.offscreen.tabs()).toEqual([{ name: 'Map', description: '材質' }, { name: 'Fog', description: '霧' }]);
    expect(h.offscreen.begin(2)).toBe(false);
    expect(h.log.filter(l => l.startsWith('drop'))).toEqual([]);
    expect(h.offscreen.begin(3)).toBe(true); // (捨てたら true。MmeRenderer がエフェクトの資源も捨てる)
    expect(h.log.filter(l => l.startsWith('drop')).sort()).toEqual([`drop ${fx('ray.fx').id}|Fog|`, 'drop shared|Map']);
    expect(h.offscreen.tabs()).toEqual([]);
    expect(h.offscreen.texture(fx('ray.fx'), 'Map', null)).toBeNull();
  });
  it('tabDefaults: そのフレームにタブを描く最初の宣言の DefaultEffect と持ち主。描く宣言がない (DefaultEffect のない shared だけ) なら null', async () => {
    const { store, fx } = await load({
      'mat.fx': offscreenFx(decl('Map', '', true)),
      'post.fx': offscreenFx(decl('Map', 'string DefaultEffect = "self = hide; * = a.fx;";', true) + decl('Read', '', true)),
      'nest.fx': offscreenFx(decl('Mine', 'string DefaultEffect = "* = hide;";')),
    });
    const h = harness(store);
    const a = obj(1), b = obj(2);
    h.offscreen.begin(1);
    h.offscreen.ensure(fx('mat.fx'), null, frameOf(1));
    h.offscreen.ensure(fx('post.fx'), null, frameOf(1));
    h.offscreen.ensure(fx('nest.fx'), a, frameOf(1));
    h.offscreen.ensure(fx('nest.fx'), b, frameOf(1));
    const map = h.offscreen.tabDefaults('Map')!;
    expect(map.defaults.rules.map(r => r.pattern)).toEqual(['self', '*']);
    expect(map.defaults.folder).toBe(fx('post.fx').folder);
    expect([...map.owners]).toEqual([null]);
    expect(h.offscreen.tabDefaults('Read')).toBeNull();
    expect([...h.offscreen.tabDefaults('Mine')!.owners]).toEqual([a, b]);
    h.offscreen.begin(2);
    expect(h.offscreen.tabDefaults('Map')).toBeNull();
  });
});
