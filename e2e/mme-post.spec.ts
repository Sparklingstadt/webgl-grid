import { expect, test, type Page } from './fixtures/test';
import { addPmx, addPost, assignFx, diff, objectFx, openMme, setCamera, shoot, type Vec3 } from './mme-helpers';
import type { Win } from './helpers';

// MME 互換のポストエフェクトとレンダーターゲット (Script・入れ子・MRT・深度のターゲット・向き・半ピクセル)。
// 書き出しは 320×240 (openMme の既定)。テスト用の .pmx は 4×20×4 の四角柱 (置くと x, z が ±0.2、高さ 2)

const W = 320, H = 240;
const FACE: Vec3 = [0, 1, 0.2]; // 箱の前の面の真ん中
const SKY: Vec3 = [1.5, 2.2, 0]; // 何もない所
const SOLID = objectFx('return float4(0.2, 0.4, 0.6, 1.0);'); // 箱の色 (51, 102, 153)

// ポストエフェクトの共通の部分: 場面を写すレンダーターゲット (ScnMap)・深度 (DepthBuffer)・全面の四角の VS
const HEAD = (filter = 'POINT') => `
float Script : STANDARDSGLOBAL < string ScriptOutput = "color"; string ScriptClass = "scene"; string ScriptOrder = "postprocess"; > = 0.8;
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
const scale = (c: number[], k: number) => c.map(v => v * k);

test('色の反転: 1 − 元の色', async ({ page }) => {
  const errors = await openMme(page);
  await solidBox(page);
  expect(await addPost(page, filterFx('return float4(1.0 - c.rgb, 1.0);'))).toBe(true);
  const r = await shoot(page, 'png', [FACE, SKY]);
  expect(rgb(r.pixels[0])).toEqual([204, 153, 102]);
  expect(rgb(r.pixels[1])).toEqual([204, 204, 204]); // 1 − ClearColor
  expect(errors).toEqual([]);
});

test('ViewportRatio = 0.5 の中間のレンダーターゲットを使う 2 pass のぼかし', async ({ page }) => {
  const errors = await openMme(page);
  // 1. 縦の線 (80・81 列) と横の線 (60・61 行) を ScnMap に描く
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
${technique('RenderColorTarget0=ScnMap; RenderDepthStencilTarget=DepthBuffer; Pass=Lines; RenderColorTarget0=Half; Pass=BlurH; RenderColorTarget0=; RenderDepthStencilTarget=; Pass=BlurV;',
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
  expect(errors).toEqual([]);
});

test('VPOS.y は上の行が 0', async ({ page }) => {
  const errors = await openMme(page);
  // 行 0 は赤、行 1 は緑、ほかは青。左半分はレンダーターゲットに描いて写したもの、右半分は canvas に直接描いたもの
  const fx = `${HEAD()}
float4 Rows(float2 vpos : VPOS) : COLOR0 { return vpos.y < 1.0 ? float4(1, 0, 0, 1) : vpos.y < 2.0 ? float4(0, 1, 0, 1) : float4(0, 0, 1, 1); }
float4 Show(float2 Tex : TEXCOORD0, float2 vpos : VPOS) : COLOR0 { return Tex.x < 0.5 ? tex2D(ScnSamp, Tex) : Rows(vpos); }
${technique('RenderColorTarget0=ScnMap; RenderDepthStencilTarget=DepthBuffer; Pass=Rows; RenderColorTarget0=; RenderDepthStencilTarget=; Pass=Show;',
    pass('Rows', 'Rows()') + pass('Show', 'Show()'))}`;
  expect(await addPost(page, fx)).toBe(true);
  const r = await shoot(page, 'png', [], true);
  const at = (x: number, y: number) => r.data.slice((y * W + x) * 4, (y * W + x) * 4 + 3);
  for (const x of [W / 4, (3 * W) / 4]) {
    expect([at(x, 0), at(x, 1), at(x, 2), at(x, H - 1)], `x = ${x}`).toEqual([[255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 0, 255]]);
  }
  expect(errors).toEqual([]);
});

test('ViewportOffset を足して 1:1 で写すと、市松模様がにじまない (半ピクセル)', async ({ page }) => {
  const errors = await openMme(page);
  // 1 画素の市松模様 (赤) と、列の偶奇 (緑)・行の偶奇 (青) を ScnMap に描き、LINEAR のサンプラーで canvas に写す。
  // 半画素ずれるとにじみ (128)、1 画素ずれると偶奇が逆になる
  const fx = `${HEAD('LINEAR')}
float4 Checker(float2 vpos : VPOS) : COLOR0 { float2 p = floor(vpos); return float4(fmod(p.x + p.y, 2.0) < 0.5 ? 1 : 0, fmod(p.x, 2.0), fmod(p.y, 2.0), 1); }
float4 Copy(float2 Tex : TEXCOORD0) : COLOR0 { return tex2D(ScnSamp, Tex); }
${technique('RenderColorTarget0=ScnMap; RenderDepthStencilTarget=DepthBuffer; Pass=Checker; RenderColorTarget0=; RenderDepthStencilTarget=; Pass=Copy;',
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
${technique('RenderColorTarget0=Half; RenderDepthStencilTarget=; Pass=Mark; RenderColorTarget0=; Pass=Show;', pass('Mark', 'Mark()') + pass('Show', 'Show()'))}`;
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
  await page.evaluate(() => (window as Win).engine.mme.store.movePost(1, -1));
  await check(c.map(v => 1 - v * 0.5)); // 半分にしてから反転
  await page.evaluate(() => (window as Win).engine.mme.store.setPostEnabled(1, false)); // 反転をオフ
  await check(c.map(v => v * 0.5));
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
  expect(await page.evaluate(() => (window as Win).engine.mme.renderer.warnings)).toEqual([]);
  expect(errors).toEqual([]);
});
