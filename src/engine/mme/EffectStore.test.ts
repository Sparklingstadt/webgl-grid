import { describe, expect, it, vi } from 'vitest';
import { pickTechnique, type TechniqueQuery } from '../../core/mme/technique.ts';
import type { MmdPass } from '../../core/mme/semantics.ts';
import type { UiChannel } from '../UiChannel';
import { EffectStore } from './EffectStore.ts';

function fakeUi() {
  return { toast: vi.fn() } as unknown as UiChannel & { toast: ReturnType<typeof vi.fn> };
}

// フォルダから選んだファイル (webkitRelativePath は 'フォルダ/…')
function fileAt(path: string, text: string): File {
  const f = new File([text], path.slice(path.lastIndexOf('/') + 1));
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

  it('load: サブフォルダの #include を大文字小文字を無視して読む', async () => {
    const ui = fakeUi();
    const store = new EffectStore(ui);
    const files = [
      fileAt('MyFx/Main.fx', `#include "Sub/Common.fxsub"\n${MINIMAL}`),
      fileAt('MyFx/sub/common.FXSUB', 'float4 Tint() { return float4(1, 0, 0, 1); }'),
    ];
    const e = await store.load(files, 'Main.fx');
    expect(e.result).toMatchObject({ ok: true, warnings: [] });
    expect(e.entry).toBe('Main.fx');
    expect([...e.bytes.keys()].sort()).toEqual(['Main.fx', 'sub/common.FXSUB']);
    expect(new TextDecoder().decode(e.bytes.get('sub/common.FXSUB'))).toContain('Tint');
    expect(e.id).not.toBe(store.defaultEffect.id);
    expect(ui.toast).not.toHaveBeenCalled();
  });

  it('load に失敗しても LoadedEffect を返し、お知らせに最初のエラーを出す', async () => {
    const ui = fakeUi();
    const store = new EffectStore(ui);
    const e = await store.load([fileAt('Bad/bad.fx', MINIMAL)], 'bad.fx'); // Tint がない
    expect(e.result.ok).toBe(false);
    if (e.result.ok) return;
    const first = e.result.errors[0];
    expect(ui.toast).toHaveBeenCalledTimes(1);
    const text = ui.toast.mock.calls[0][0] as string;
    expect(text).toContain(e.name);
    expect(text).toContain(`${first.code} ${first.file}:${first.line} ${first.message}`);
  });

  it('物の割り当て・ポストエフェクトの並べ替え・オン・オフ・外す・物を消したら割り当ても消える', async () => {
    const store = new EffectStore(fakeUi());
    const changed = vi.fn();
    store.events.on('changed', changed);
    const a = await store.load([fileAt('A/a.fx', '')], 'a.fx');
    const b = await store.load([fileAt('B/b.fx', '')], 'b.fx');
    const c = await store.load([fileAt('C/c.fx', '')], 'c.fx');

    expect(store.objectEffect(1)).toBeNull();
    store.setObjectEffect(1, a);
    store.setObjectEffect(2, b);
    expect(store.objectEffect(1)).toBe(a);
    store.setObjectEffect(2, null);
    expect(store.objectEffect(2)).toBeNull();
    store.forgetObject(1);
    expect(store.objectEffect(1)).toBeNull();
    expect(changed).toHaveBeenCalledTimes(4);

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
    expect(changed).toHaveBeenCalledTimes(4 + 3 + 2 + 1 + 1);
  });
});
