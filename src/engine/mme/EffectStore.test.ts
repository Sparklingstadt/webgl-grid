import { describe, expect, it, vi } from 'vitest';
import { compileEffect } from '../../core/fx/index.ts';
import { pickTechnique, type TechniqueQuery } from '../../core/mme/technique.ts';
import type { MmdPass } from '../../core/mme/semantics.ts';
import type { UiChannel } from '../UiChannel';
import { EffectStore, readBinary } from './EffectStore.ts';

// compileEffect の呼ばれた数を数える (中身はそのまま)
vi.mock('../../core/fx/index.ts', async importOriginal => {
  const mod = await importOriginal<typeof import('../../core/fx/index.ts')>();
  return { ...mod, compileEffect: vi.fn(mod.compileEffect) };
});

function fakeUi() {
  return { toast: vi.fn() } as unknown as UiChannel & { toast: ReturnType<typeof vi.fn> };
}

// フォルダから選んだファイル (webkitRelativePath は 'フォルダ/…')。更新日時は決まった値 (同じファイルを読み直したとき)
function fileAt(path: string, text: string, lastModified = 1000): File {
  const f = new File([text], path.slice(path.lastIndexOf('/') + 1), { lastModified });
  Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
}

const MINIMAL = `
float4x4 WVP : WORLDVIEWPROJECTION;
float4 VS(float4 p : POSITION) : POSITION { return mul(p, WVP); }
float4 PS() : COLOR0 { return Tint(); }
technique T < string MMDPass = "object"; > { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }
`;

describe('EffectStore', () => {
  it('default.fx はエラーも警告もなくコンパイルでき、5 つの MMDPass の technique がある', () => {
    const d = new EffectStore(fakeUi()).defaultEffect;
    expect(d.result).toMatchObject({ ok: true, warnings: [] });
    if (!d.result.ok) return;
    const effect = d.result.effect;
    const passes: MmdPass[] = ['object', 'object_ss', 'zplot', 'shadow', 'edge'];
    for (const pass of passes) {
      for (const bits of [0, 1, 2, 3, 4, 5, 6, 7]) {
        const q: TechniqueQuery = { pass, subset: 0, useTexture: !!(bits & 1), useSphereMap: !!(bits & 2), useToon: !!(bits & 4), selfShadow: pass === 'object_ss' };
        const tec = pickTechnique(effect, q);
        expect(tec, `${pass} ${bits}`).not.toBeNull();
        // object_ss は object に落ちずに自分の technique を持つ
        expect(tec!.annotations.find(a => a.name === 'MMDPass')?.value).toBe(pass);
        expect(tec!.passes.length).toBeGreaterThan(0);
        expect(tec!.passes.every(p => p.program !== null)).toBe(true);
      }
    }
    // object_ss はセルフシャドウの深度を register(s0) のサンプラーで読む
    const ss = pickTechnique(effect, { pass: 'object_ss', subset: 0, useTexture: false, useSphereMap: false, useToon: true, selfShadow: true })!;
    const s0 = effect.samplers.find(s => s.register === 's0');
    expect(s0).toMatchObject({ texture: null });
    expect(ss.passes[0].program!.uniforms.some(u => u.name === s0!.name)).toBe(true);
    // 地面の影は半透明で重ね、輪郭線は表の面を消す
    const shadow = pickTechnique(effect, { pass: 'shadow', subset: 0, useTexture: false, useSphereMap: false, useToon: false, selfShadow: false })!;
    expect(shadow.passes[0].states).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'AlphaBlendEnable', value: true }),
      expect.objectContaining({ name: 'SrcBlend', value: 'SRCALPHA' }),
      expect.objectContaining({ name: 'DestBlend', value: 'INVSRCALPHA' }),
    ]));
    const edge = pickTechnique(effect, { pass: 'edge', subset: 0, useTexture: false, useSphereMap: false, useToon: false, selfShadow: false })!;
    expect(edge.passes[0].states).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'CullMode', value: 'CW' })]));
  });

  it('fxFilesIn は webkitRelativePath の先頭のフォルダを取り、.fx だけを返す', () => {
    const files = [
      fileAt('MyFx/sub/b.FX', ''), fileAt('MyFx/a.fx', ''), fileAt('MyFx/tex.png', ''), fileAt('MyFx/c.fxsub', ''),
    ];
    expect(EffectStore.fxFilesIn(files)).toEqual(['a.fx', 'sub/b.FX']);
    // フォルダでなく 1 つだけ落としたファイルは名前のまま
    expect(EffectStore.fxFilesIn([new File([''], 'one.fx')])).toEqual(['one.fx']);
  });

  it('いくつかの物をまとめて落としたとき: 先頭のフォルダが全部で同じときだけ取り、違えばそのままのパス', async () => {
    // 2 つのフォルダ (と、フォルダの外のファイル) をまとめて落とした
    const mixed = [fileAt('A/a.fx', ''), fileAt('B/sub/b.fx', ''), new File([''], 'c.fx')];
    expect(EffectStore.fxFilesIn(mixed)).toEqual(['A/a.fx', 'B/sub/b.fx', 'c.fx']);
    const store = new EffectStore(fakeUi());
    const two = await store.addFolder([fileAt('A/a.fx', '#include "../B/inc.fxsub"\ntechnique T { }'), fileAt('B/inc.fxsub', '')]);
    expect(two.name).toBe('');
    expect([...two.files.keys()].sort()).toEqual(['A/a.fx', 'B/inc.fxsub']);
    const e = store.effect(two, 'A/a.fx');
    expect(e.result.ok).toBe(true);
    expect(e.name).toBe('A/a.fx');
    expect(e.folder).toBe(two);
    // 1 つのフォルダなら、その名前を取る (名前は「フォルダ/パス」)
    const one = await store.addFolder([fileAt('Fx/sub/a.fx', 'technique T { }'), fileAt('Fx/tex.png', '')]);
    expect(one.name).toBe('Fx');
    expect([...one.files.keys()].sort()).toEqual(['sub/a.fx', 'tex.png']);
    expect(store.effect(one, 'sub/a.fx').name).toBe('Fx/sub/a.fx');
  });

  it('effect: サブフォルダの #include を大文字小文字を無視して読み、読んだパスを used に足す', async () => {
    const ui = fakeUi();
    const store = new EffectStore(ui);
    const folder = await store.addFolder([
      fileAt('MyFx/Main.fx', `#include "shader/math.fxsub"\n${MINIMAL}`),
      fileAt('MyFx/Shader/Math.fxsub', 'float4 Tint() { return float4(1, 0, 0, 1); }'),
      fileAt('MyFx/unused.fxsub', ''),
    ]);
    const e = store.effect(folder, 'main.FX'); // エントリーも大文字小文字を無視して探す
    expect(e.result).toMatchObject({ ok: true, warnings: [] });
    expect(e.entry).toBe('Main.fx');
    expect(e.name).toBe('MyFx/Main.fx');
    expect(new TextDecoder().decode(folder.text.get('Shader/Math.fxsub'))).toContain('Tint');
    expect([...folder.used].sort()).toEqual(['Main.fx', 'Shader/Math.fxsub']);
    expect(e.id).not.toBe(store.defaultEffect.id);
    expect(ui.toast).not.toHaveBeenCalled();
  });

  it('effect は同じフォルダ・同じパス (大文字小文字は問わない) なら同じ LoadedEffect を返し、コンパイルは 1 回', async () => {
    const store = new EffectStore(fakeUi());
    const folder = await store.addFolder([fileAt('Fx/a.fx', 'technique T { }'), fileAt('Fx/b.fx', 'technique T { }')]);
    vi.mocked(compileEffect).mockClear();
    const a = store.effect(folder, 'a.fx');
    expect(store.effect(folder, 'a.fx')).toBe(a);
    expect(store.effect(folder, './A.FX')).toBe(a);
    expect(compileEffect).toHaveBeenCalledTimes(1);
    expect(store.effect(folder, 'b.fx')).not.toBe(a);
    expect(compileEffect).toHaveBeenCalledTimes(2);
    // 既定の default.fx は builtin のフォルダにある
    expect(store.effect(store.defaultEffect.folder, 'default.fx')).toBe(store.defaultEffect);
    expect(store.defaultEffect.folder.id).toBe('builtin');
    expect(store.folder('builtin')).toBe(store.defaultEffect.folder);
    expect(store.folders()).toEqual([folder]); // (読み込んだフォルダだけ)
    expect(store.folder(folder.id)).toBe(folder);
    expect(store.folder('nothing')).toBeNull();
  });

  it('画像は addFolder では読まず、readBinary で (大文字小文字を無視して) 読んで used に足す', async () => {
    const store = new EffectStore(fakeUi());
    const fx = fileAt('Fx/a.fx', 'technique T { }');
    const png = fileAt('Fx/Tex/Stone.png', 'PNG!');
    const fxRead = vi.spyOn(fx, 'arrayBuffer');
    const pngRead = vi.spyOn(png, 'arrayBuffer');
    const folder = await store.addFolder([fx, png]);
    expect(fxRead).toHaveBeenCalledTimes(1);
    expect(pngRead).not.toHaveBeenCalled();
    expect([...folder.text.keys()]).toEqual(['a.fx']);
    expect(folder.used.size).toBe(0);
    const bytes = await readBinary(folder, 'tex\\stone.PNG');
    expect(new TextDecoder().decode(bytes!)).toBe('PNG!');
    expect(pngRead).toHaveBeenCalledTimes(1);
    expect([...folder.used]).toEqual(['Tex/Stone.png']);
    expect(await readBinary(folder, 'nothing.png')).toBeNull();
    expect([...folder.used]).toEqual(['Tex/Stone.png']);
  });

  it('同じ名前のフォルダを 2 回読むと 1 つにまとめ、ないファイルだけ足す。変わったファイル (大きさ・更新日時・文字のファイルの中身) は新しいほうにしてコンパイルし直す', async () => {
    const store = new EffectStore(fakeUi());
    const first = await store.addFolder([fileAt('Ray/a.fx', 'technique T { }'), fileAt('Ray/tex.png', 'x')]);
    const a = store.effect(first, 'a.fx');
    // 同じ中身で読み直しても、コンパイル結果はそのまま
    expect(await store.addFolder([fileAt('Ray/a.fx', 'technique T { }')])).toBe(first);
    expect(store.effect(first, 'a.fx')).toBe(a);
    // 2 回目にだけあったファイルを足す (足りないファイルを補う)
    const keep = first.files.get('tex.png');
    const again = await store.addFolder([fileAt('Ray/a.fx', 'technique T { }'), fileAt('Ray/tex.png', 'x'), fileAt('Ray/Lighting/b.fx', 'technique T { }')]);
    expect(again).toBe(first);
    expect(store.folders()).toEqual([first]);
    expect([...first.files.keys()].sort()).toEqual(['Lighting/b.fx', 'a.fx', 'tex.png']);
    expect(first.files.get('tex.png')).toBe(keep);
    expect(first.text.has('Lighting/b.fx')).toBe(true);
    // 大きさが違うファイルは新しいほうにして、コンパイル結果を捨てる
    const before = store.effect(first, 'a.fx');
    await store.addFolder([fileAt('Ray/a.fx', 'float4 x = ;')]);
    const b = store.effect(first, 'a.fx');
    expect(b).not.toBe(before);
    expect(b.result.ok).toBe(false);
    // ファイルを足したときもコンパイルし直す (足りなかった #include が読めるように)
    await store.addFolder([fileAt('Ray/c.fx', '#include "inc.fxsub"\ntechnique T { }')]);
    expect(store.effect(first, 'c.fx').result.ok).toBe(false);
    await store.addFolder([fileAt('Ray/inc.fxsub', '')]);
    expect(store.effect(first, 'c.fx').result.ok).toBe(true);
    // 大きさが同じでも、中身・更新日時が変われば新しいほうにしてコンパイルし直す
    const red = store.effect(first, 'Lighting/b.fx');
    await store.addFolder([fileAt('Ray/Lighting/b.fx', 'technique U { }', 2000)]);
    const blue = store.effect(first, 'Lighting/b.fx');
    expect(blue).not.toBe(red);
    expect(new TextDecoder().decode(first.text.get('Lighting/b.fx'))).toBe('technique U { }');
    expect(blue.result.ok && blue.result.effect.techniques.map(x => x.name)).toEqual(['U']);
    // 中身は同じでも更新日時が違う画像は新しいほう
    const png = fileAt('Ray/tex.png', 'y', 3000);
    await store.addFolder([png]);
    expect(first.files.get('tex.png')).toBe(png);
    // 更新日時が同じでも、文字のファイルは中身を比べる
    await store.addFolder([fileAt('Ray/Lighting/b.fx', 'technique V { }', 2000)]);
    expect(new TextDecoder().decode(first.text.get('Lighting/b.fx'))).toBe('technique V { }');
    expect(store.effect(first, 'Lighting/b.fx')).not.toBe(blue);
    // 名前の違うフォルダは別
    const other = await store.addFolder([fileAt('Other/a.fx', 'technique T { }')]);
    expect(other).not.toBe(first);
    expect(other.id).not.toBe(first.id);
    expect(store.folders()).toEqual([first, other]);
    // 同じ名前のフォルダを続けて (前のを読み終える前に) 読んでも 1 つ
    const [p, q] = await Promise.all([store.addFolder([fileAt('New/a.fx', '')]), store.addFolder([fileAt('New/b.fx', '')])]);
    expect(p).toBe(q);
    expect([...p.files.keys()].sort()).toEqual(['a.fx', 'b.fx']);
  });

  it('共通のフォルダの名前がないもの (1 つだけ落としたファイルなど) は、読むたびに別のフォルダ', async () => {
    const store = new EffectStore(fakeUi());
    const one = await store.addFolder([new File(['technique A { }'], 'a.fx')]);
    const two = await store.addFolder([new File(['technique B { }'], 'a.fx')]);
    expect(one).not.toBe(two);
    expect(store.folders()).toEqual([one, two]);
    const a = store.effect(one, 'a.fx'), b = store.effect(two, 'a.fx');
    expect([a.result.ok && a.result.effect.techniques[0].name, b.result.ok && b.result.effect.techniques[0].name]).toEqual(['A', 'B']);
    expect(a.name).toBe('a.fx');
  });

  it('effect に失敗しても LoadedEffect を返し、初めてのときだけお知らせに最初のエラーを出す', async () => {
    const ui = fakeUi();
    const store = new EffectStore(ui);
    const folder = await store.addFolder([fileAt('Bad/bad.fx', MINIMAL)]);
    const e = store.effect(folder, 'bad.fx'); // Tint がない
    expect(e.result.ok).toBe(false);
    if (e.result.ok) return;
    const first = e.result.errors[0];
    expect(ui.toast).toHaveBeenCalledTimes(1);
    const text = ui.toast.mock.calls[0][0] as string;
    expect(text).toContain(e.name);
    expect(text).toContain(`${first.code} ${first.file}:${first.line} ${first.message}`);
    expect(store.effect(folder, 'bad.fx')).toBe(e);
    expect(ui.toast).toHaveBeenCalledTimes(1);
  });

  it('effect: フォルダにないファイルは ok でない結果 (FX-IO-NOT-FOUND)', async () => {
    const ui = fakeUi();
    const store = new EffectStore(ui);
    const folder = await store.addFolder([fileAt('Fx/a.fx', 'technique T { }')]);
    const e = store.effect(folder, 'sub/none.fx');
    expect(e.result.ok).toBe(false);
    expect(e.result.ok ? [] : e.result.errors.map(d => d.code)).toEqual(['FX-IO-NOT-FOUND']);
    expect(e.entry).toBe('sub/none.fx');
    expect(store.effect(folder, 'sub/none.fx')).toBe(e);
    expect(ui.toast).toHaveBeenCalledTimes(1);
  });

  it('ポストエフェクトの並べ替え・オン・オフ・外す・全部外す', async () => {
    const store = new EffectStore(fakeUi());
    const changed = vi.fn();
    store.events.on('changed', changed);
    const a = store.effect(await store.addFolder([fileAt('A/a.fx', '')]), 'a.fx');
    const b = store.effect(await store.addFolder([fileAt('B/b.fx', '')]), 'b.fx');
    const c = store.effect(await store.addFolder([fileAt('C/c.fx', '')]), 'c.fx');

    store.addPost(a); store.addPost(b); store.addPost(c);
    expect(store.posts.map(p => p.effect)).toEqual([a, b, c]);
    expect(store.posts.every(p => p.enabled)).toBe(true);
    store.movePost(0, 1);
    expect(store.posts.map(p => p.effect)).toEqual([b, a, c]);
    store.movePost(2, -1);
    expect(store.posts.map(p => p.effect)).toEqual([b, c, a]);
    store.movePost(0, -1); // 端からは動かない
    store.movePost(2, 1);
    expect(store.posts.map(p => p.effect)).toEqual([b, c, a]);
    store.setPostEnabled(1, false);
    expect(store.posts.map(p => p.enabled)).toEqual([true, false, true]);
    store.removePost(0);
    expect(store.posts).toEqual([{ effect: c, enabled: false }, { effect: a, enabled: true }]);
    expect(changed).toHaveBeenCalledTimes(3 + 2 + 1 + 1);
    store.clear();
    expect(store.posts).toEqual([]);
    store.clear(); // (何もなければ知らせない)
    expect(changed).toHaveBeenCalledTimes(3 + 2 + 1 + 1 + 1);
  });
});
