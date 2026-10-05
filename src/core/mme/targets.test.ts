import { describe, expect, it } from 'vitest';
import { compileEffect } from '../fx/index.ts';
import { addDictionary, setLang } from '../i18n.ts';
import en from '../../i18n/en.ts';
import { targetSpec } from './targets.ts';

const TECH = 'float4 VS(float4 p : POSITION) : POSITION { return p; } float4 PS() : COLOR0 { return 1; } technique T { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }';

// テクスチャの宣言を 1 つコンパイルして targetSpec にかける
function spec(decl: string, screen: [number, number], depth = false) {
  const r = compileEffect('a.fx', p => (p === 'a.fx' ? new TextEncoder().encode(`${decl} ${TECH}`) : null));
  if (!r.ok) throw new Error(r.errors.map(e => `${e.code}: ${e.message}`).join('\n'));
  return targetSpec(r.effect.textures[0], screen, depth);
}

describe('targetSpec', () => {
  it('ViewportRatio・Dimensions・Format・MipLevels', () => {
    expect(spec('texture2D T : RENDERCOLORTARGET < float2 ViewportRatio = {0.5, 0.5}; string Format = "D3DFMT_A16B16G16R16F"; >;', [801, 600]))
      .toEqual({ width: 401, height: 300, format: 'rgba16f', mipmaps: false, warnings: [] }); // MipLevels がなければ 1 とみなす
    expect(spec('texture2D T : RENDERCOLORTARGET < int2 Dimensions = {256, 128}; int MipLevels = 0; >;', [800, 600])).toMatchObject({ width: 256, height: 128, mipmaps: true });
    expect(spec('texture2D D : RENDERDEPTHSTENCILTARGET;', [800, 600], true)).toMatchObject({ format: 'depth24stencil8' });
  });

  it('注釈がなければ画面と同じ大きさの rgba8', () => {
    expect(spec('texture2D T : RENDERCOLORTARGET;', [800, 600])).toEqual({ width: 800, height: 600, format: 'rgba8', mipmaps: false, warnings: [] });
  });

  it('Width・Height で大きさを決める', () => {
    expect(spec('texture2D T : RENDERCOLORTARGET < int Width = 64; int Height = 32; >;', [800, 600])).toMatchObject({ width: 64, height: 32 });
  });

  it('Dimensions は ViewportRatio より優先する', () => {
    expect(spec('texture2D T : RENDERCOLORTARGET < int2 Dimensions = {256, 128}; float2 ViewportRatio = {0.5, 0.5}; >;', [800, 600]))
      .toMatchObject({ width: 256, height: 128 });
  });

  it('Width だけのときは Height を ViewportRatio から決める', () => {
    expect(spec('texture2D T : RENDERCOLORTARGET < int Width = 64; float2 ViewportRatio = {1, 0.5}; >;', [800, 600]))
      .toMatchObject({ width: 64, height: 300 });
  });

  it('明示した大きさも四捨五入して最小 1', () => {
    expect(spec('texture2D T : RENDERCOLORTARGET < float2 Dimensions = {100.6, 0.2}; >;', [800, 600])).toMatchObject({ width: 101, height: 1 });
  });

  it('大きさは最小 1 で、MipLevels が 2 以上でも mipmaps になる', () => {
    expect(spec('texture2D T : RENDERCOLORTARGET < float2 ViewportRatio = {0.0001, 0.0001}; int MipLevels = 5; >;', [800, 600]))
      .toMatchObject({ width: 1, height: 1, mipmaps: true });
  });

  it('Format は大文字小文字・D3DFMT_ の有無を問わない', () => {
    const f = (name: string) => spec(`texture2D T : RENDERCOLORTARGET < string Format = "${name}"; >;`, [10, 10]).format;
    expect(['A8R8G8B8', 'X8R8G8B8', 'a8b8g8r8', 'D3DFMT_A8R8G8B8'].map(f)).toEqual(['rgba8', 'rgba8', 'rgba8', 'rgba8']);
    expect(['A16B16G16R16F', 'A32B32G32R32F', 'R16F', 'r32f', 'G16R16F', 'D3DFMT_G32R32F'].map(f))
      .toEqual(['rgba16f', 'rgba32f', 'r16f', 'r32f', 'rg16f', 'rg32f']);
  });

  it('深度の Format と mipmaps', () => {
    const d = (name: string) => spec(`texture2D D : RENDERDEPTHSTENCILTARGET < string Format = "${name}"; int MipLevels = 0; >;`, [10, 10], true);
    for (const n of ['D24S8', 'D24X8', 'D16']) expect(d(n)).toMatchObject({ format: 'depth24stencil8', mipmaps: false, warnings: [] });
  });

  it('知らない形式は既定にして警告を足す', () => {
    const r = spec('texture2D T : RENDERCOLORTARGET < string Format = "FOO"; >;', [10, 10]);
    expect(r.format).toBe('rgba8');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('FOO');
    const d = spec('texture2D D : RENDERDEPTHSTENCILTARGET < string Format = "FOO"; >;', [10, 10], true);
    expect(d.format).toBe('depth24stencil8');
    expect(d.warnings).toHaveLength(1);
  });

  it('色に深度の形式 (深度に色の形式) を書いても既定にして警告する', () => {
    expect(spec('texture2D T : RENDERCOLORTARGET < string Format = "D24S8"; >;', [10, 10])).toMatchObject({ format: 'rgba8', warnings: [expect.any(String)] });
    expect(spec('texture2D D : RENDERDEPTHSTENCILTARGET < string Format = "A8R8G8B8"; >;', [10, 10], true)).toMatchObject({ format: 'depth24stencil8', warnings: [expect.any(String)] });
  });

  it('警告は画面の言語で出す', () => {
    addDictionary('en', en);
    setLang('en');
    try {
      expect(spec('texture2D T : RENDERCOLORTARGET < string Format = "FOO"; >;', [10, 10]).warnings)
        .toEqual(["Format FOO of render target T can't be used, so the default is used"]);
    } finally {
      setLang('ja');
    }
  });
});
