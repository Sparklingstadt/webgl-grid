import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileEffect, type EffectResult } from '../src/core/fx/index.ts';
import { corpusFrom, rayConfVariants } from '../src/core/fx/testing/rayCorpus.ts';
import { expect, test } from './fixtures/test';
import { linkAll, runPixel } from './fx-harness';

// FX コンパイラ (src/core/fx) の出力を本物の WebGL2 で確かめる: Ray-MMD の全プログラムのリンクと、小さな HLSL の値

// --- Ray-MMD 1.5.2 の全 .fx と ray.conf の切り替えを Node 側で変換し、プログラムの重なりを除く ---
// 単体テスト (corpus.test.ts) と同じく、.fx・.fxsub・.conf を文字列で読んで corpusFrom に渡す
const ROOT = fileURLToPath(new URL('../third_party/ray-mmd-1.5.2/', import.meta.url));
const sources: Record<string, string> = {};
for (const e of readdirSync(ROOT, { recursive: true, withFileTypes: true })) {
  if (!e.isFile() || !/\.(fx|fxsub|conf)$/.test(e.name)) continue;
  const rel = path.relative(ROOT, path.join(e.parentPath, e.name)).split(path.sep).join('/');
  sources[rel] = readFileSync(path.join(ROOT, rel), 'utf8');
}
const corpus = corpusFrom(sources);
const listFiles = () => corpus.listFiles();
const read = (p: string) => corpus.readFile(p);
const entries = corpus.listFiles().filter(n => n.endsWith('.fx'));
// ray.conf がなければ、切り替えが 0 個のまま黙って通らないよう、ここで落とす
const rayConf = corpus.readFile('ray.conf');
if (!rayConf) throw new Error(`ray.conf が見つからない: ${ROOT}`);
const variants = rayConfVariants(new TextDecoder().decode(rayConf));

const unique = new Map<string, { name: string; vertex: string; fragment: string }>();
const compileErrors: string[] = [];
let compiled = 0, noProgram = 0;
function collect(label: string, r: EffectResult) {
  if (!r.ok) {
    compileErrors.push(`${label}: ${r.errors[0]?.code} ${r.errors[0]?.file}:${r.errors[0]?.line} ${r.errors[0]?.message}`);
    return;
  }
  compiled++;
  for (const t of r.effect.techniques) {
    for (const p of t.passes) {
      if (!p.program) { noProgram++; continue; }
      const key = p.program.vertex + '\0' + p.program.fragment;
      if (!unique.has(key)) unique.set(key, { name: `${label} ${t.name}/${p.name}`, vertex: p.program.vertex, fragment: p.program.fragment });
    }
  }
}
for (const e of entries) collect(e, compileEffect(e, read, { listFiles }));
for (const v of variants) {
  const conf = new TextEncoder().encode(v.conf);
  collect(`ray.fx (${v.name})`, compileEffect('ray.fx', p => (p === 'ray.conf' ? conf : read(p)), { listFiles }));
}
const programs = [...unique.values()];
const CHUNK = 150;

test.describe('Ray-MMD のプログラムが WebGL2 でリンクできる', () => {
  test('.fx 515 個と ray.conf の切り替え 52 個を、すべてエラー 0 で変換する', () => {
    expect(entries.length).toBe(515);
    expect(variants.length).toBe(52);
    expect(compileErrors).toEqual([]);
    expect(compiled).toBe(515 + 52);
    // 重なりを除いたプログラムは 600 個以上 (書き出しが変わると増減するので下限だけ)。program のない pass はない
    expect(programs.length).toBeGreaterThanOrEqual(600);
    expect(noProgram).toBe(0);
  });
  test('linkAll はリンクできないものを名前とログで返す', async ({ page }) => {
    await page.goto('about:blank');
    const head = '#version 300 es\nprecision highp float;\n';
    const vertex = `${head}out vec2 v;\nvoid main() { v = vec2(0.0); gl_Position = vec4(0.0); }`;
    const fragment = `${head}in vec2 v;\nout vec4 o;\nvoid main() { o = vec4(v, 0.0, 1.0); }`;
    const failed = await linkAll(page, [
      { name: 'よい', vertex, fragment },
      { name: 'フラグメントの型の誤り', vertex, fragment: `${head}out vec4 o;\nvoid main() { o = 1; }` },
      { name: '頂点の型の誤り', vertex: `${head}void main() { gl_Position = 1; }`, fragment: `${head}out vec4 o;\nvoid main() { o = vec4(1.0); }` },
      // どちらもコンパイルはできて、リンクだけが失敗する (頂点とフラグメントで v の型が違う)
      { name: 'リンクだけの誤り', vertex, fragment: `${head}in vec3 v;\nout vec4 o;\nvoid main() { o = vec4(v, 1.0); }` },
    ]);
    expect(failed.map(f => f.name)).toEqual(['フラグメントの型の誤り', '頂点の型の誤り', 'リンクだけの誤り']);
    expect(failed[0].log).toMatch(/^fragment: \S/);
    expect(failed[1].log).toMatch(/^vertex: \S/);
    expect(failed[2].log).toMatch(/^link: \S/);
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

// 読んだ値と期待する値をくらべる: 出力の数と成分の数はそのまま、値は float32 の誤差を許す (-0 と 0 は同じ)
function expectPixels(actual: number[][], expected: number[][]) {
  expect(actual.map(px => px.length)).toEqual(expected.map(px => px.length));
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(b));
  // 近い成分は期待する値に置きかえ、違う成分だけが差分に出るようにする
  expect(actual.map((px, i) => px.map((a, j) => (close(a, expected[i][j]) ? expected[i][j] : a)))).toEqual(expected);
}

const VS = 'float4 VS(float4 p : POSITION) : POSITION { return p; }';
const technique = (ps: string) => `technique T { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 ${ps}; } }`;

test.describe('HLSL の値が WebGL2 で合う', () => {
  test.beforeEach(async ({ page }) => { await page.goto('about:blank'); });

  for (const [name, body, expected] of cases) {
    test(name, async ({ page }) => {
      expectPixels(await runPixel(page, body), expected);
    });
  }

  test('runPixel はプログラムにない uniform の名前で止まる', async ({ page }) => {
    await expect(runPixel(page, 'return 0;', { kk: [1] })).rejects.toThrow('uniform kk はプログラムにない');
  });

  test('static の初期値を uniform から計算する', async ({ page }) => {
    const hlsl = `float k; static float k2 = k * 2 + 1;
${VS}
float4 PS() : COLOR0 { return float4(k2, 0, 0, 0); }
${technique('PS()')}`;
    expectPixels(await runPixel(page, hlsl, { k: [3] }), [[7, 0, 0, 0]]);
  });

  test('uniform の行列 (D3D の行優先の数のまま送る)', async ({ page }) => {
    const hlsl = `float4x3 M;
${VS}
float4 PS() : COLOR0 { return float4(mul(float4(1,0,2,1), M), 0); }
${technique('PS()')}`;
    expectPixels(await runPixel(page, hlsl, { M: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }), [[25, 29, 33, 0]]);
  });

  test('pass の uniform の引数', async ({ page }) => {
    const hlsl = `${VS}
float4 PS(uniform float2 off) : COLOR0 { return float4(off, off + 0.5); }
${technique('PS(float2(0.25, 0.5))')}`;
    expectPixels(await runPixel(page, hlsl), [[0.25, 0.5, 0.75, 1]]);
  });

  test('MRT', async ({ page }) => {
    const hlsl = `${VS}
void PS(out float4 c0 : COLOR0, out float4 c1 : COLOR1, out float4 c2 : COLOR2) { c0 = float4(1, 0, 0, 1); c1 = float4(0, 1, 0, 1); c2 = float4(0, 0, 1, 1); }
${technique('PS()')}`;
    expectPixels(await runPixel(page, hlsl), [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1]]);
  });
});
