import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileEffect, type EffectResult } from '../src/core/fx/index.ts';
import { rayConfVariants } from '../src/core/fx/testing/rayCorpus.ts';
import { expect, test } from './fixtures/test';
import { linkAll, runPixel } from './fx-harness';

// FX コンパイラ (src/core/fx) の出力を本物の WebGL2 で確かめる: Ray-MMD の全プログラムのリンクと、小さな HLSL の値

// --- Ray-MMD 1.5.2 の全 .fx と ray.conf の切り替えを Node 側で変換し、プログラムの重なりを除く ---
const ROOT = fileURLToPath(new URL('../third_party/ray-mmd-1.5.2/', import.meta.url));
const files: Record<string, Uint8Array> = {};
for (const e of readdirSync(ROOT, { recursive: true, withFileTypes: true })) {
  if (!e.isFile()) continue;
  const rel = path.relative(ROOT, path.join(e.parentPath, e.name)).split(path.sep).join('/');
  files[rel] = readFileSync(path.join(ROOT, rel));
}
const names = Object.keys(files).sort();
const listFiles = () => names.slice();
const read = (p: string) => (Object.hasOwn(files, p) ? files[p] : null);

const unique = new Map<string, { name: string; vertex: string; fragment: string }>();
const compileErrors: string[] = [];
function collect(label: string, r: EffectResult) {
  if (!r.ok) {
    compileErrors.push(`${label}: ${r.errors[0]?.code} ${r.errors[0]?.file}:${r.errors[0]?.line} ${r.errors[0]?.message}`);
    return;
  }
  for (const t of r.effect.techniques) {
    for (const p of t.passes) {
      if (!p.program) continue;
      const key = p.program.vertex + '\0' + p.program.fragment;
      if (!unique.has(key)) unique.set(key, { name: `${label} ${t.name}/${p.name}`, vertex: p.program.vertex, fragment: p.program.fragment });
    }
  }
}
for (const e of names.filter(n => n.endsWith('.fx'))) collect(e, compileEffect(e, read, { listFiles }));
for (const v of rayConfVariants(new TextDecoder().decode(files['ray.conf']))) {
  const conf = new TextEncoder().encode(v.conf);
  collect(`ray.fx (${v.name})`, compileEffect('ray.fx', p => (p === 'ray.conf' ? conf : read(p)), { listFiles }));
}
const programs = [...unique.values()];
const CHUNK = 150;

test.describe('Ray-MMD のプログラムが WebGL2 でリンクできる', () => {
  test('変換はエラー 0 で、プログラムがある', () => {
    expect(compileErrors).toEqual([]);
    expect(programs.length).toBeGreaterThan(0);
  });
  test('linkAll はリンクできないものを名前とログで返す', async ({ page }) => {
    await page.goto('about:blank');
    const vertex = '#version 300 es\nvoid main() { gl_Position = vec4(0.0); }';
    const failed = await linkAll(page, [
      { name: 'よい', vertex, fragment: '#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() { o = vec4(1.0); }' },
      { name: '型の誤り', vertex, fragment: '#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() { o = 1; }' },
    ]);
    expect(failed.map(f => f.name)).toEqual(['型の誤り']);
    expect(failed[0].log).toContain('fragment:');
  });
  for (let i = 0; i < programs.length; i += CHUNK) {
    const chunk = programs.slice(i, i + CHUNK);
    test(`プログラム ${i + 1}〜${i + chunk.length} / ${programs.length}`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.goto('about:blank');
      expect(await linkAll(page, chunk)).toEqual([]);
    });
  }
});

// --- 値: HLSL の仕様から手で計算したもの ---
const cases: [string, string, number[][]][] = [
  ['mul(v, M) の 4x3', 'float4x3 M = float4x3(1,2,3, 4,5,6, 7,8,9, 10,11,12); return float4(mul(float4(1,0,2,1), M), 0);', [[25, 29, 33, 0]]],
  ['mul(M, v) の 3x4', 'float3x4 N = float3x4(1,2,3,4, 5,6,7,8, 9,10,11,12); return float4(mul(N, float4(1,1,0,2)), 0);', [[11, 27, 43, 0]]],
  ['行列の行と要素', 'float3x4 N = float3x4(1,2,3,4, 5,6,7,8, 9,10,11,12); return float4(N[1].w, N._m21, N._14, 0);', [[8, 10, 4, 0]]],
  ['fmod', 'return float4(fmod(5.5, 2), fmod(-5.5, 2), fmod(5.5, -2), 0);', [[1.5, -1.5, 1.5, 0]]],
  ['int の割り算と剰余', 'int a = -7; int b = 2; return float4(a / b, a % b, 7 / 2, 7 % -2);', [[-3, -1, 3, 1]]],
  ['スワズルへの代入', 'float4 c = 0; c.zx = float2(1, 2); float s = 3; c.yw = s.xx; return c;', [[2, 3, 1, 3]]],
  ['暗黙の切り詰めと広げ', 'float3 t = float4(1,2,3,4); float4 u = 0.5; return float4(t.z, u.y, dot(t, 1), 0);', [[3, 0.5, 6, 0]]],
  ['ベクトルの比較と選択', 'float3 x = float3(1,5,3); float3 r = (x > 2) ? 10 : 20; return float4(r, all(x) && !any(float3(0,0,0)) ? 1 : 0);', [[20, 10, 10, 1]]],
  ['for の変数はループのあとも見える', 'for (int j = 0; j < 3; j++) {} return float4(j, 0, 0, 0);', [[3, 0, 0, 0]]],
];

const VS = 'float4 VS(float4 p : POSITION) : POSITION { return p; }';
const technique = (ps: string) => `technique T { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 ${ps}; } }`;

test.describe('HLSL の値が WebGL2 で合う', () => {
  test.beforeEach(async ({ page }) => { await page.goto('about:blank'); });

  for (const [name, body, expected] of cases) {
    test(name, async ({ page }) => {
      expect(await runPixel(page, body)).toEqual(expected);
    });
  }

  test('static の初期値を uniform から計算する', async ({ page }) => {
    const hlsl = `float k; static float k2 = k * 2 + 1;
${VS}
float4 PS() : COLOR0 { return float4(k2, 0, 0, 0); }
${technique('PS()')}`;
    expect(await runPixel(page, hlsl, { k: [3] })).toEqual([[7, 0, 0, 0]]);
  });

  test('pass の uniform の引数', async ({ page }) => {
    const hlsl = `${VS}
float4 PS(uniform float2 off) : COLOR0 { return float4(off, off + 0.5); }
${technique('PS(float2(0.25, 0.5))')}`;
    expect(await runPixel(page, hlsl)).toEqual([[0.25, 0.5, 0.75, 1]]);
  });

  test('MRT', async ({ page }) => {
    const hlsl = `${VS}
void PS(out float4 c0 : COLOR0, out float4 c1 : COLOR1, out float4 c2 : COLOR2) { c0 = float4(1, 0, 0, 1); c1 = float4(0, 1, 0, 1); c2 = float4(0, 0, 1, 1); }
${technique('PS()')}`;
    expect(await runPixel(page, hlsl)).toEqual([[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1]]);
  });
});
