import { expect, test, type Page } from './fixtures/test';
import { addPmx, addPost, assignFx, diff, objectFx, openMme, setCamera, setSun, shoot, type Vec3 } from './mme-helpers';
import type { Win } from './helpers';

// MME 互換のポストエフェクトとレンダーターゲット (Script・入れ子・MRT・深度のターゲット・向き・半ピクセル)。
// 書き出しは 320×240 (openMme の既定)。テスト用の .pmx は 4×20×4 の四角柱 (置くと x, z が ±0.2、高さ 2)

const W = 320, H = 240;
const FACE: Vec3 = [0, 1, 0.2]; // 箱の前の面の真ん中
const SKY: Vec3 = [1.5, 2.2, 0]; // 何もない所
const SOLID = objectFx('return float4(0.2, 0.4, 0.6, 1.0);'); // 箱の色 (51, 102, 153)

// ポストエフェクトの共通の部分: 場面を写すレンダーターゲット (ScnMap)・深度 (DepthBuffer)・全面の四角の VS
const HEAD = (filter = 'POINT', order = 'postprocess') => `
float Script : STANDARDSGLOBAL < string ScriptOutput = "color"; string ScriptClass = "scene"; string ScriptOrder = "${order}"; > = 0.8;
float2 ViewportSize : VIEWPORTPIXELSIZE;
static float2 ViewportOffset = float2(0.5, 0.5) / ViewportSize;
float4 ClearColor = { 0.2, 0.2, 0.2, 1.0 };
float ClearDepth = 1.0;
texture2D ScnMap : RENDERCOLORTARGET < float2 ViewportRatio = { 1.0, 1.0 }; string Format = "A8R8G8B8"; >;
sampler2D ScnSamp = sampler_state { texture = <ScnMap>; MinFilter = ${filter}; MagFilter = ${filter}; MipFilter = NONE; AddressU = CLAMP; AddressV = CLAMP; };
texture2D DepthBuffer : RENDERDEPTHSTENCILTARGET < float2 ViewportRatio = { 1.0, 1.0 }; string Format = "D24S8"; >;
struct VO { float4 Pos : POSITION; float2 Tex : TEXCOORD0; };
VO VS(float4 Pos : POSITION, float2 Tex : TEXCOORD0) { VO o; o.Pos = Pos; o.Tex = Tex + ViewportOffset; return o; }
`;
// 場面を ScnMap に描く Script の前半
const CAPTURE = 'RenderColorTarget0=ScnMap; RenderDepthStencilTarget=DepthBuffer; ClearSetColor=ClearColor; ClearSetDepth=ClearDepth; Clear=Color; Clear=Depth; ScriptExternal=Color; ';
const pass = (name: string, ps: string, states = '', vs = 'VS()') =>
  `pass ${name} < string Script = "Draw=Buffer;"; > { ${states} VertexShader = compile vs_3_0 ${vs}; PixelShader = compile ps_3_0 ${ps}; }`;
const technique = (script: string, passes: string) => `technique Post < string Script = "${script}"; > { ${passes} }`;

// 場面を写して、PS で色を変えて canvas に出すポストエフェクト
const filterFx = (ps: string) => `${HEAD()}
float4 Main(float2 Tex : TEXCOORD0) : COLOR0 { float4 c = tex2D(ScnSamp, Tex); ${ps} }
${technique(`${CAPTURE}RenderColorTarget0=; RenderDepthStencilTarget=; Pass=Main;`, pass('Main', 'Main()'))}`;

// 箱を 1 つ置いて単色の .fx を当て、+z から見る
async function solidBox(page: Page) {
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  const i = await addPmx(page, { flags: 0 });
  expect(await assignFx(page, i, SOLID)).toBe(true);
  return i;
}

const rgb = (p: number[]) => p.slice(0, 3);
// 描くときの警告 (全体の警告と、エフェクトごとの警告。Framebuffers・Script の警告はエフェクトのもの)
const warnings = (page: Page) => page.evaluate(() => (window as Win).engine.mme.renderer.allWarnings() as string[]);
const scale = (c: number[], k: number) => c.map(v => v * k);

test('色の反転: 1 − 元の色', async ({ page }) => {
  const errors = await openMme(page);
  await solidBox(page);
  expect(await addPost(page, filterFx('return float4(1.0 - c.rgb, 1.0);'))).toBe(true);
  const r = await shoot(page, 'png', [FACE, SKY]);
  expect(rgb(r.pixels[0])).toEqual([204, 153, 102]);
  expect(rgb(r.pixels[1])).toEqual([204, 204, 204]); // 1 − ClearColor
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('ViewportRatio = 0.5 の中間のレンダーターゲットを使う 2 pass のぼかし', async ({ page }) => {
  const errors = await openMme(page);
  // 1. 縦の線 (80・81 列) と横の線 (60・61 行) を ScnMap に描く (写した場面の上に描く)
  // 2. 半分の大きさの Half へ、横に 3 タップ (1/4・1/2・1/4) でぼかす (LINEAR。DX9 の画素の位置なら、Half の (i, j) は ScnMap の (2i, 2j) を読む)
  // 3. canvas へ、縦に 3 タップでぼかす (POINT。canvas の (x, y) は Half の (x/2, y/2) を読む)
  const fx = `${HEAD('LINEAR')}
texture2D Half : RENDERCOLORTARGET < float2 ViewportRatio = { 0.5, 0.5 }; string Format = "A8R8G8B8"; >;
sampler2D HalfSamp = sampler_state { texture = <Half>; MinFilter = POINT; MagFilter = POINT; MipFilter = NONE; AddressU = CLAMP; AddressV = CLAMP; };
float4 Lines(float2 vpos : VPOS) : COLOR0 {
  float2 p = floor(vpos);
  return (p.x == 80.0 || p.x == 81.0 || p.y == 60.0 || p.y == 61.0) ? float4(1, 1, 1, 1) : float4(0, 0, 0, 1);
}
float4 BlurH(float2 Tex : TEXCOORD0) : COLOR0 {
  float2 d = float2(2.0 / ViewportSize.x, 0);
  return tex2D(ScnSamp, Tex - d) * 0.25 + tex2D(ScnSamp, Tex) * 0.5 + tex2D(ScnSamp, Tex + d) * 0.25;
}
float4 BlurV(float2 Tex : TEXCOORD0) : COLOR0 {
  float2 d = float2(0, 2.0 / ViewportSize.y);
  return tex2D(HalfSamp, Tex - d) * 0.25 + tex2D(HalfSamp, Tex) * 0.5 + tex2D(HalfSamp, Tex + d) * 0.25;
}
${technique(`${CAPTURE}Pass=Lines; RenderColorTarget0=Half; Pass=BlurH; RenderColorTarget0=; RenderDepthStencilTarget=; Pass=BlurV;`,
    pass('Lines', 'Lines()') + pass('BlurH', 'BlurH()') + pass('BlurV', 'BlurV()'))}`;
  expect(await addPost(page, fx)).toBe(true);
  const r = await shoot(page, 'png', [], true);
  const at = (x: number, y: number) => r.data[(y * W + x) * 4];
  // Half: 40 列 = 1/2、39・41 列 = 1/4、30 行 = 1。canvas: その縦の 1/4・1/2・1/4
  expect(Math.abs(at(80, 200) - 128), 'at(80, 200)').toBeLessThanOrEqual(1); // 縦の線 (0.5)
  expect(Math.abs(at(81, 10) - 128), 'at(81, 10)').toBeLessThanOrEqual(1);
  expect(Math.abs(at(78, 200) - 64), 'at(78, 200)').toBeLessThanOrEqual(1); // 横ににじむ (0.25)
  expect(Math.abs(at(83, 200) - 64), 'at(83, 200)').toBeLessThanOrEqual(1);
  expect(at(84, 200)).toBe(0);
  expect(Math.abs(at(250, 60) - 128), 'at(250, 60)').toBeLessThanOrEqual(1); // 横の線 (0.5)
  expect(Math.abs(at(250, 58) - 64), 'at(250, 58)').toBeLessThanOrEqual(1); // 縦ににじむ (0.25)
  expect(Math.abs(at(250, 63) - 64), 'at(250, 63)').toBeLessThanOrEqual(1);
  expect(at(250, 64)).toBe(0);
  // 真ん中: 1/4 × 1/2 + 1/2 × 1 + 1/4 × 1/2 = 3/4
  expect(Math.abs(at(80, 60) - 191.5), 'at(80, 60)').toBeLessThanOrEqual(1);
  expect(Math.abs(at(81, 61) - 191.5), 'at(81, 61)').toBeLessThanOrEqual(1);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('LoopByCount と LoopGetIndex: 3 回足して 3 倍', async ({ page }) => {
  const errors = await openMme(page);
  await solidBox(page);
  // canvas を黒で消してから、場面の色 × (番号 + 1) / 2 を 3 回足す: (1 + 2 + 3) / 2 = 3 倍
  const fx = `${HEAD()}
int LoopCount = 3;
float LoopIndex;
float4 Black = { 0, 0, 0, 1 };
float4 Add(float2 Tex : TEXCOORD0) : COLOR0 { return float4(tex2D(ScnSamp, Tex).rgb * 0.5 * (LoopIndex + 1.0), 1.0); }
${technique(`${CAPTURE}RenderColorTarget0=; RenderDepthStencilTarget=; ClearSetColor=Black; Clear=Color; LoopByCount=LoopCount; LoopGetIndex=LoopIndex; Pass=Add; LoopEnd=;`,
    pass('Add', 'Add()', 'AlphaBlendEnable = TRUE; SrcBlend = ONE; DestBlend = ONE;'))}`;
  expect(await addPost(page, fx)).toBe(true);
  // 箱の色を小さくして 3 倍が収まるようにする
  expect(await assignFx(page, 0, objectFx('return float4(0.2, 0.1, 0.25, 1.0);'))).toBe(true);
  const r = await shoot(page, 'png', [FACE]);
  const want = scale([0.2, 0.1, 0.25], 3 * 255);
  expect(diff(r.pixels[0], want), `${r.pixels[0]} ≈ ${want}`).toBeLessThanOrEqual(2);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('MRT: COLOR0・COLOR1 を別のターゲットに書き、2 つ目を表示', async ({ page }) => {
  const errors = await openMme(page);
  await solidBox(page);
  // Split: COLOR0 = 場面の色を A へ、COLOR1 = 場面の色の BGR を B へ。Show: 上半分は A、下半分は B
  const fx = `${HEAD()}
texture2D A : RENDERCOLORTARGET < float2 ViewportRatio = { 1.0, 1.0 }; >;
texture2D B : RENDERCOLORTARGET < float2 ViewportRatio = { 1.0, 1.0 }; >;
sampler2D ASamp = sampler_state { texture = <A>; MinFilter = POINT; MagFilter = POINT; AddressU = CLAMP; AddressV = CLAMP; };
sampler2D BSamp = sampler_state { texture = <B>; MinFilter = POINT; MagFilter = POINT; AddressU = CLAMP; AddressV = CLAMP; };
float4 Red = { 1, 0, 0, 1 };
struct Out2 { float4 C0 : COLOR0; float4 C1 : COLOR1; };
Out2 Split(float2 Tex : TEXCOORD0) { float4 c = tex2D(ScnSamp, Tex); Out2 o; o.C0 = c; o.C1 = float4(c.bgr, 1); return o; }
float4 Show(float2 Tex : TEXCOORD0) : COLOR0 { return Tex.y < 0.5 ? tex2D(ASamp, Tex) : tex2D(BSamp, Tex); }
${technique(`${CAPTURE}RenderColorTarget0=A; RenderColorTarget1=B; ClearSetColor=Red; Clear=Color; Pass=Split; RenderColorTarget1=; RenderColorTarget0=; RenderDepthStencilTarget=; Pass=Show;`,
    pass('Split', 'Split()') + pass('Show', 'Show()'))}`;
  expect(await addPost(page, fx)).toBe(true);
  const r = await shoot(page, 'png', [[0, 1.6, 0.2], [0, 0.4, 0.2]]);
  expect(rgb(r.pixels[0])).toEqual([51, 102, 153]); // A (上)
  expect(rgb(r.pixels[1])).toEqual([153, 102, 51]); // B (下)
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('レンダーターゲットの左上を読むと場面の左上', async ({ page }) => {
  const errors = await openMme(page);
  // 箱を左に置き、注視点を下げて、箱の上の部分が画面の左上に来るようにする
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0, dist: 4.5, ty: 0.2 });
  const i = await addPmx(page, { flags: 0, at: [-1, 0] });
  expect(await assignFx(page, i, SOLID)).toBe(true);
  const p: Vec3 = [-1, 1.5, 0.2];
  const before = await shoot(page, 'png', [p]);
  const [px, py] = before.pos[0];
  expect(px < W / 2 && py < H / 2, `${px}, ${py}`).toBe(true);
  expect(rgb(before.pixels[0])).toEqual([51, 102, 153]);
  // 画面全体に、レンダーターゲットのその位置 (D3D の座標: v = 0 が上) の色を出す。右半分は上下を返した位置
  const u = (px + 0.5) / W, v = (py + 0.5) / H;
  const fx = `${HEAD()}
float4 Main(float2 Tex : TEXCOORD0) : COLOR0 { return Tex.x < 0.5 ? tex2D(ScnSamp, float2(${u}, ${v})) : tex2D(ScnSamp, float2(${u}, ${1 - v})); }
${technique(`${CAPTURE}RenderColorTarget0=; RenderDepthStencilTarget=; Pass=Main;`, pass('Main', 'Main()'))}`;
  expect(await addPost(page, fx)).toBe(true);
  const r = await shoot(page, 'png', [], true);
  const at = (x: number, y: number) => r.data.slice((y * W + x) * 4, (y * W + x) * 4 + 3);
  expect(at(10, 10)).toEqual([51, 102, 153]);
  expect(at(W - 10, H - 10)).toEqual([51, 51, 51]); // ClearColor
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('VPOS.y は上の行が 0', async ({ page }) => {
  const errors = await openMme(page);
  // 行 0 は赤、行 1 は緑、ほかは青。左半分はレンダーターゲットに描いて写したもの、右半分は canvas に直接描いたもの
  const fx = `${HEAD()}
float4 Rows(float2 vpos : VPOS) : COLOR0 { return vpos.y < 1.0 ? float4(1, 0, 0, 1) : vpos.y < 2.0 ? float4(0, 1, 0, 1) : float4(0, 0, 1, 1); }
float4 Show(float2 Tex : TEXCOORD0, float2 vpos : VPOS) : COLOR0 { return Tex.x < 0.5 ? tex2D(ScnSamp, Tex) : Rows(vpos); }
${technique(`${CAPTURE}Pass=Rows; RenderColorTarget0=; RenderDepthStencilTarget=; Pass=Show;`,
    pass('Rows', 'Rows()') + pass('Show', 'Show()'))}`;
  expect(await addPost(page, fx)).toBe(true);
  const r = await shoot(page, 'png', [], true);
  const at = (x: number, y: number) => r.data.slice((y * W + x) * 4, (y * W + x) * 4 + 3);
  for (const x of [W / 4, (3 * W) / 4]) {
    expect([at(x, 0), at(x, 1), at(x, 2), at(x, H - 1)], `x = ${x}`).toEqual([[255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 0, 255]]);
  }
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('ViewportOffset を足して 1:1 で写すと、市松模様がにじまない (半ピクセル)', async ({ page }) => {
  const errors = await openMme(page);
  // 1 画素の市松模様 (赤) と、列の偶奇 (緑)・行の偶奇 (青) を ScnMap に描き、LINEAR のサンプラーで canvas に写す。
  // 半画素ずれるとにじみ (128)、1 画素ずれると偶奇が逆になる
  const fx = `${HEAD('LINEAR')}
float4 Checker(float2 vpos : VPOS) : COLOR0 { float2 p = floor(vpos); return float4(fmod(p.x + p.y, 2.0) < 0.5 ? 1 : 0, fmod(p.x, 2.0), fmod(p.y, 2.0), 1); }
float4 Copy(float2 Tex : TEXCOORD0) : COLOR0 { return tex2D(ScnSamp, Tex); }
${technique(`${CAPTURE}Pass=Checker; RenderColorTarget0=; RenderDepthStencilTarget=; Pass=Copy;`,
    pass('Checker', 'Checker()') + pass('Copy', 'Copy()'))}`;
  expect(await addPost(page, fx)).toBe(true);
  const r = await shoot(page, 'png', [], true);
  const bad: string[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const want = [(x + y) % 2 === 0 ? 255 : 0, (x % 2) * 255, (y % 2) * 255];
      const got = rgb(r.data.slice((y * W + x) * 4, (y * W + x) * 4 + 4));
      if (diff(got, want) !== 0 && bad.length < 5) bad.push(`(${x}, ${y}) = ${got}`);
    }
  }
  expect(bad).toEqual([]);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('同じ深度のターゲットを 2 つの色のターゲットで使うと、奥の物が隠れる', async ({ page }) => {
  const errors = await openMme(page);
  await solidBox(page);
  // A に場面 (箱) を DepthBuffer と描き、同じ DepthBuffer で B にいちばん奥の赤い四角を描く。B を出すと、箱の所だけ赤が隠れる
  const fx = `${HEAD()}
texture2D B : RENDERCOLORTARGET < float2 ViewportRatio = { 1.0, 1.0 }; >;
sampler2D BSamp = sampler_state { texture = <B>; MinFilter = POINT; MagFilter = POINT; AddressU = CLAMP; AddressV = CLAMP; };
float4 Black = { 0, 0, 0, 1 };
VO FarVS(float4 Pos : POSITION, float2 Tex : TEXCOORD0) { VO o; o.Pos = float4(Pos.xy, 0.9999, 1); o.Tex = Tex; return o; }
float4 Red() : COLOR0 { return float4(1, 0, 0, 1); }
float4 Show(float2 Tex : TEXCOORD0) : COLOR0 { return tex2D(BSamp, Tex); }
${technique(`${CAPTURE}RenderColorTarget0=B; ClearSetColor=Black; Clear=Color; Pass=Far; RenderColorTarget0=; RenderDepthStencilTarget=; Pass=Show;`,
    pass('Far', 'Red()', 'ZEnable = TRUE; ZWriteEnable = FALSE; ZFunc = LESSEQUAL;', 'FarVS()') + pass('Show', 'Show()'))}`;
  expect(await addPost(page, fx)).toBe(true);
  const r = await shoot(page, 'png', [FACE, SKY]);
  expect(rgb(r.pixels[0])).toEqual([0, 0, 0]); // 箱の前で隠れた
  expect(rgb(r.pixels[1])).toEqual([255, 0, 0]);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('大きさを変えて 2 回書き出しても、ViewportRatio と VIEWPORTPIXELSIZE が書き出しの大きさに合う', async ({ page }) => {
  const errors = await openMme(page);
  // Half (半分の大きさ) の (i, j) に (i, j) / 255 を書き、canvas に POINT で写す。青は VIEWPORTPIXELSIZE.x / 510
  const fx = `${HEAD()}
texture2D Half : RENDERCOLORTARGET < float2 ViewportRatio = { 0.5, 0.5 }; >;
sampler2D HalfSamp = sampler_state { texture = <Half>; MinFilter = POINT; MagFilter = POINT; AddressU = CLAMP; AddressV = CLAMP; };
float4 Mark(float2 vpos : VPOS) : COLOR0 { return float4(floor(vpos) / 255.0, 0, 1); }
float4 Show(float2 Tex : TEXCOORD0) : COLOR0 { return float4(tex2D(HalfSamp, Tex).rg, ViewportSize.x / 510.0, 1); }
${technique(`${CAPTURE}RenderColorTarget0=Half; RenderDepthStencilTarget=; Pass=Mark; RenderColorTarget0=; Pass=Show;`, pass('Mark', 'Mark()') + pass('Show', 'Show()'))}`;
  expect(await addPost(page, fx)).toBe(true);
  for (const [w, h] of [[320, 240], [200, 160]]) {
    await page.evaluate(({ w, h }) => (window as Win).engine.output.set({ width: w, height: h }), { w, h });
    const r = await shoot(page, 'png', [], true);
    expect([r.width, r.height]).toEqual([w, h]);
    const at = (x: number, y: number) => r.data.slice((y * w + x) * 4, (y * w + x) * 4 + 3);
    const blue = Math.round((w / 510) * 255);
    expect(at(0, 0)).toEqual([0, 0, blue]);
    expect(at(w - 1, h - 1)).toEqual([w / 2 - 1, h / 2 - 1, blue]);
    expect(at(w / 2 + 1, 3)).toEqual([w / 4, 1, blue]);
  }
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('ポストエフェクトの順番を入れ替えると結果が変わり、オフにすると飛ばされる', async ({ page }) => {
  const errors = await openMme(page);
  await solidBox(page);
  // 一覧の上ほど先に (場面の近くで) かかる
  expect(await addPost(page, filterFx('return float4(1.0 - c.rgb, 1.0);'), 'invert.fx')).toBe(true);
  expect(await addPost(page, filterFx('return float4(c.rgb * 0.5, 1.0);'), 'half.fx')).toBe(true);
  const c = [0.2, 0.4, 0.6];
  const face = async () => (await shoot(page, 'png', [FACE])).pixels[0];
  const check = async (want: number[]) => {
    const got = await face();
    expect(diff(got, scale(want, 255)), `${got} ≈ ${scale(want, 255)}`).toBeLessThanOrEqual(2);
  };
  await check(c.map(v => (1 - v) * 0.5)); // 反転してから半分
  // 並びはアクセサリの物の並び (reorder_objects と同じ)
  await page.evaluate(() => { const { engine } = window as Win; const [invert, half] = engine.mme.posts().map((p: Win) => p.obj); engine.setOrder([half.id, invert.id]); });
  await check(c.map(v => 1 - v * 0.5)); // 半分にしてから反転
  // オフ = アクセサリを隠す (画面のオン・オフと同じく、ビューポートでも書き出しでも)
  await page.evaluate(() => { const { engine } = window as Win; engine.setVisibility(engine.mme.posts()[1].obj, { hidden: true, hideRender: true }); }); // 反転をオフ
  await check(c.map(v => v * 0.5));
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('物の .fx の Script でレンダーターゲットに描き、次の pass で読む', async ({ page }) => {
  const errors = await openMme(page);
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  const i = await addPmx(page, { flags: 0 });
  // Write: 箱の色を Obj に描く。Read: canvas に、Obj の同じ画素の色の BGR を出す
  const fx = `
float4x4 WVP : WORLDVIEWPROJECTION;
float2 ViewportSize : VIEWPORTPIXELSIZE;
float4 Clear0 = { 0, 0, 0, 0 };
texture2D Obj : RENDERCOLORTARGET < float2 ViewportRatio = { 1.0, 1.0 }; >;
sampler2D ObjSamp = sampler_state { texture = <Obj>; MinFilter = POINT; MagFilter = POINT; AddressU = CLAMP; AddressV = CLAMP; };
float4 VS(float4 Pos : POSITION) : POSITION { return mul(Pos, WVP); }
float4 Write() : COLOR0 { return float4(0.2, 0.4, 0.6, 1); }
float4 Read(float2 vpos : VPOS) : COLOR0 { return float4(tex2D(ObjSamp, (vpos + 0.5) / ViewportSize).bgr, 1); }
technique T < string MMDPass = "object"; string Script = "RenderColorTarget0=Obj; ClearSetColor=Clear0; Clear=Color; Pass=Write; RenderColorTarget0=; Pass=Read;"; > {
  pass Write { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 Write(); }
  pass Read { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 Read(); }
}`;
  expect(await assignFx(page, i, fx)).toBe(true);
  const r = await shoot(page, 'png', [FACE]);
  expect(rgb(r.pixels[0])).toEqual([153, 102, 51]);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('地面の影は重なっても 1 回だけ暗くなる (ステンシル)。ポストエフェクトがあってもなくても', async ({ page }) => {
  const errors = await openMme(page);
  // 太陽は左手前の上から (影は右奥へ、高さ 2 の箱で長さ 2)。B は A の影の中に立つので、B より先では 2 つの影が重なる。
  // (両面の材質なので、1 つの箱の影の中でも表と裏の三角形が重なる)。カメラは上から地面を見る
  await setSun(page, { azimuthDeg: 150, elevationDeg: 45 });
  await setCamera(page, { yaw: Math.PI / 2, pitch: 1.2, dist: 7, tx: 0.8, tz: -0.5 });
  await addPmx(page, { name: 'A', flags: 0x03, at: [0, 0] });
  await addPmx(page, { name: 'B', flags: 0x03, at: [0.43, -0.25] });
  const both: Vec3 = [0.87, 0, -0.5];    // A と B の影が重なる地面
  const single: Vec3 = [1.95, 0, -1.13]; // B の影だけの地面
  const look = async (bg: number, where: 'png' | 'viewport' = 'png') => {
    const r = await shoot(page, where, [both, single]);
    const half = [bg * 0.5, bg * 0.5, bg * 0.5];
    expect(diff(r.pixels[1], half), `${r.pixels[1]}`).toBeLessThanOrEqual(2);
    expect(diff(r.pixels[0], r.pixels[1]), `${r.pixels[0]} = ${r.pixels[1]}`).toBeLessThanOrEqual(1);
  };
  // (ステンシルはフレームごとに消すので、何度描いても同じ。ビューポートは大きさが変わらないので、深度のターゲットを作り直さない)
  await page.evaluate(() => { (window as Win).engine.graph.grid.visible = false; });
  await look(0x3d);
  await look(0x3d, 'viewport');
  await look(0x3d, 'viewport');
  // 場面を自分のレンダーターゲットと深度のターゲット (Clear=Depth はステンシルも消す) に描いて、そのまま写すポストエフェクト
  // (背景は ClearColor の 51)
  expect(await addPost(page, filterFx('return c;'))).toBe(true);
  await look(51);
  await look(51, 'viewport');
  await look(51, 'viewport');
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('shared のレンダーターゲットは、物の .fx とポストエフェクトで同じもの (物が書いた赤を、ポストエフェクトが読んで出す)', async ({ page }) => {
  const errors = await openMme(page);
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  const i = await addPmx(page, { flags: 0 });
  // 物の .fx (A) が、形を書いた shared の G に、箱を赤で描く。表には描かない
  const objectSide = `
float4x4 WVP : WORLDVIEWPROJECTION;
float4 Black = { 0, 0, 0, 1 };
shared texture2D G : RENDERCOLORTARGET < float2 ViewportRatio = { 1.0, 1.0 }; string Format = "A8R8G8B8"; >;
float4 VS(float4 Pos : POSITION) : POSITION { return mul(Pos, WVP); }
float4 Red() : COLOR0 { return float4(1, 0, 0, 1); }
technique T < string MMDPass = "object"; string Script = "RenderColorTarget0=G; ClearSetColor=Black; Clear=Color; Pass=Write; RenderColorTarget0=;"; > {
  pass Write { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 Red(); }
}`;
  expect(await assignFx(page, i, objectSide)).toBe(true);
  // ポストエフェクト (B) は、形を書かない shared の G を宣言して、場面 (A が G に書く) を描いたあと、G を canvas に出す
  const post = `${HEAD()}
shared texture2D G : RENDERCOLORTARGET;
sampler2D GSamp = sampler_state { texture = <G>; MinFilter = POINT; MagFilter = POINT; MipFilter = NONE; AddressU = CLAMP; AddressV = CLAMP; };
float4 Show(float2 Tex : TEXCOORD0) : COLOR0 { return tex2D(GSamp, Tex); }
${technique(`${CAPTURE}RenderColorTarget0=; RenderDepthStencilTarget=; Pass=Show;`, pass('Show', 'Show()'))}`;
  expect(await addPost(page, post)).toBe(true);
  const r = await shoot(page, 'png', [FACE, SKY]);
  expect(rgb(r.pixels[0])).toEqual([255, 0, 0]);
  expect(rgb(r.pixels[1])).toEqual([0, 0, 0]);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('MipLevels = 0 のレンダーターゲットに縦縞を書いて、tex2Dlod の粗い段で読むと平均の色', async ({ page }) => {
  const errors = await openMme(page);
  // 1 列おきに白・黒の縦縞を Stripes (全段のミップマップ) に書き、いちばん粗い段 (tex2Dlod の 10。段の数を超えた分は最後の段) を canvas に出す
  const fx = `${HEAD()}
texture2D Stripes : RENDERCOLORTARGET < float2 ViewportRatio = { 1.0, 1.0 }; int MipLevels = 0; >;
sampler2D StripesSamp = sampler_state { texture = <Stripes>; MinFilter = LINEAR; MagFilter = LINEAR; MipFilter = LINEAR; AddressU = CLAMP; AddressV = CLAMP; };
float4 Write(float2 vpos : VPOS) : COLOR0 { float v = fmod(floor(vpos.x), 2.0) < 1.0 ? 1.0 : 0.0; return float4(v, v, v, 1); }
float4 Show(float2 Tex : TEXCOORD0) : COLOR0 { return float4(tex2Dlod(StripesSamp, float4(Tex, 0, 10)).rgb, 1); }
${technique(`${CAPTURE}RenderColorTarget0=Stripes; RenderDepthStencilTarget=; Pass=Write; RenderColorTarget0=; Pass=Show;`, pass('Write', 'Write()') + pass('Show', 'Show()'))}`;
  expect(await addPost(page, fx)).toBe(true);
  const r = await shoot(page, 'png', [], true);
  for (const [x, y] of [[10, 10], [160, 120], [301, 200]]) {
    expect(Math.abs(r.data[(y * W + x) * 4] - 128), `(${x}, ${y})`).toBeLessThanOrEqual(2);
  }
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

// 全面を 1 色で塗るだけのポストエフェクト (ScriptExternal なし。ScriptOrder は order)
const fillFx = (order: string, color: string, extra = '') => `${HEAD('POINT', order)}
float4 Fill() : COLOR0 { return ${color}; }
${extra}${technique('Pass=Fill;', pass('Fill', 'Fill()'))}`;

test('ScriptOrder = preprocess は場面より先に画面に塗るので、塗った色が Main の物の後ろに残る', async ({ page }) => {
  const errors = await openMme(page);
  await solidBox(page);
  expect(await addPost(page, fillFx('preprocess', 'float4(0.8, 0.2, 0.2, 1.0)'))).toBe(true);
  const r = await shoot(page, 'png', [FACE, SKY]);
  expect(rgb(r.pixels[0])).toEqual([51, 102, 153]); // 箱は上に描かれる
  expect(rgb(r.pixels[1])).toEqual([204, 51, 51]); // 背景は preprocess の色
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('preprocess と postprocess: 場面をそのまま通す postprocess なら塗った背景が残り、場面を別のターゲットに写す postprocess なら残らない', async ({ page }) => {
  const errors = await openMme(page);
  await solidBox(page);
  // 一覧の順 (postprocess が先) にかかわらず、preprocess は場面の前に画面へ描く
  const passThrough = `${HEAD()}\n${technique('ScriptExternal=Color;', '')}`;
  expect(await addPost(page, passThrough, 'through.fx')).toBe(true);
  expect(await addPost(page, fillFx('preprocess', 'float4(0.8, 0.2, 0.2, 1.0)'), 'fill.fx')).toBe(true);
  let r = await shoot(page, 'png', [FACE, SKY]);
  expect(rgb(r.pixels[0])).toEqual([51, 102, 153]);
  expect(rgb(r.pixels[1])).toEqual([204, 51, 51]);
  // 場面を ScnMap に写して反転する postprocess を足すと、画面の preprocess の色は読まれず、ScnMap を消す ClearColor が背景
  expect(await addPost(page, filterFx('return float4(1.0 - c.rgb, 1.0);'), 'invert.fx')).toBe(true);
  r = await shoot(page, 'png', [FACE, SKY]);
  expect(rgb(r.pixels[0])).toEqual([204, 153, 102]);
  expect(rgb(r.pixels[1])).toEqual([204, 204, 204]);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('ポストエフェクトの technique は MMDPass のないもの (先頭に MMDPass = object の technique があっても選ばない)', async ({ page }) => {
  const errors = await openMme(page);
  await solidBox(page);
  const objectTech = 'technique Obj < string MMDPass = "object"; string Script = "Pass=Fill;"; > { pass Fill < string Script = "Draw=Buffer;"; > { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 Bad(); } }\n';
  const fx = `${HEAD('POINT', 'preprocess')}
float4 Fill() : COLOR0 { return float4(0.8, 0.2, 0.2, 1.0); }
float4 Bad() : COLOR0 { return float4(0.0, 1.0, 0.0, 1.0); }
${objectTech}${technique('Pass=Fill;', pass('Fill', 'Fill()'))}`;
  expect(await addPost(page, fx)).toBe(true);
  const r = await shoot(page, 'png', [SKY]);
  expect(rgb(r.pixels[0])).toEqual([204, 51, 51]);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('ScriptOrder = standard のポストエフェクトは、警告を出して postprocess として扱う', async ({ page }) => {
  const errors = await openMme(page);
  await solidBox(page);
  expect(await addPost(page, filterFx('return float4(1.0 - c.rgb, 1.0);').replace('"postprocess"', '"standard"'))).toBe(true);
  const r = await shoot(page, 'png', [FACE, SKY]);
  expect(rgb(r.pixels[0])).toEqual([204, 153, 102]);
  expect(rgb(r.pixels[1])).toEqual([204, 204, 204]);
  expect((await warnings(page)).some(w => w.includes('ScriptOrder = standard'))).toBe(true);
  expect(errors).toEqual([]);
});

// --- ポストエフェクト = アクセサリの物に当てた .fx。CONTROLOBJECT の (self) はそのアクセサリ ---
// 場面を写して、アクセサリの Si 倍の色にするポストエフェクト
const SELF_SI = 'float s : CONTROLOBJECT < string name = "(self)"; string item = "Si"; >;\n';
const siFx = filterFx('return float4(c.rgb * s, 1.0);').replace('float4 Main(', `${SELF_SI}float4 Main(`);
const BOX = [51, 102, 153];

test('ポストエフェクトの CONTROLOBJECT (self) はそのアクセサリの値: アクセサリの Si を 0.5 → 1 にすると色が変わる', async ({ page }) => {
  const errors = await openMme(page);
  await solidBox(page);
  expect(await addPost(page, siFx, 'si.fx')).toBe(true);
  expect(await page.evaluate(() => (window as Win).engine.mme.posts().map((p: Win) => p.obj.mmeObj))).toEqual([{ kind: 'accessory', name: 'si.x' }]);
  const at = async (si: number) => {
    await page.evaluate(si => {
      const { engine } = window as Win;
      engine.mme.posts()[0].obj.mmeValues.Si = si;
      engine.viewport.requestDraw();
    }, si);
    return rgb((await shoot(page, 'png', [FACE])).pixels[0]);
  };
  const half = await at(0.5);
  expect(diff(half, scale(BOX, 0.5)), `${half}`).toBeLessThanOrEqual(2);
  expect(await at(1)).toEqual(BOX);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('アクセサリの Si のキーフレームで、書き出した動画の最初のコマと最後のコマの色が違う', async ({ page }) => {
  const errors = await openMme(page);
  await solidBox(page);
  expect(await addPost(page, siFx, 'si.fx')).toBe(true);
  const frames = await page.evaluate(async () => {
    const { engine } = window as Win;
    const acc = engine.mme.posts()[0].obj;
    engine.clock.setRange(0, 10);
    engine.clock.seekFrame(0); acc.mmeValues.Si = 0.25; engine.keyframes.insertMme(acc, 0, ['Si']);
    engine.clock.seekFrame(10); acc.mmeValues.Si = 1; engine.keyframes.insertMme(acc, 10, ['Si']);
    engine.clock.seekFrame(5);
    // 書き出す各コマの絵 (動画に入れる前の絵) の真ん中の画素
    const out = engine.output as Win;
    const flatten = out.flatten.bind(out);
    const colors: number[][] = [];
    out.flatten = (to: HTMLCanvasElement) => {
      flatten(to);
      const d = to.getContext('2d')!.getImageData(to.width >> 1, to.height >> 1, 1, 1).data;
      colors.push([d[0], d[1], d[2]]);
    };
    try {
      await engine.output.renderVideo();
    } finally {
      out.flatten = flatten;
    }
    return colors;
  });
  expect(frames).toHaveLength(11);
  const first = frames[0], last = frames[frames.length - 1];
  expect(diff(first, scale(BOX, 0.25)), `${first}`).toBeLessThanOrEqual(2);
  expect(diff(last, BOX), `${last}`).toBeLessThanOrEqual(2);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});
