import { expect, test, type Page } from './fixtures/test';
import { addPmx, addPost, assignFx, objectFx, openMme, setCamera, shoot, type Vec3 } from './mme-helpers';
import type { Win } from './helpers';

// MME 互換の CONTROLOBJECT: 物の .fx が読む値は、(self)・名前が合う場面の物 (モーフ・骨・ワールド行列) か、
// 場面にない名前 (ray_controller.pmx など) の「仮のコントローラー」(engine.mme.setControl) から来る。
// テスト用の .pmx は 4×20×4 の四角柱 (置くと x, z が ±0.2、高さ 2)。カメラは +z から見て、見る物をカメラの注視点の真下に置いて真ん中の画素を見る。

const BLACK = [0, 0, 0, 255], RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255];
const face = (x = 0, z = 0, y = 1): Vec3 => [x, y, z + 0.2]; // 箱の前の面
const look = (page: Page, x = 0, z = 0) => setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, tx: x, ty: 1, tz: z });
const warnings = (page: Page) => page.evaluate(() => (window as Win).engine.mme.renderer.allWarnings() as string[]);
const colorAt = async (page: Page, x = 0) => { await look(page, x); return (await shoot(page, 'png', [face(x)])).pixels[0]; };

// 物の .fx: 赤を name・item の float、緑を (self) の同じく float で決める
const item = (name: string, it: string, type = 'float') => `${type} m : CONTROLOBJECT < string name = "${name}"; string item = "${it}"; >;`;
const redFrom = (name: string, it: string) => objectFx('return float4(m, 0.0, 0.0, 1.0);', item(name, it));
const greenFrom = (name: string, it: string) => objectFx('return float4(0.0, m, 0.0, 1.0);', item(name, it));

// モーフ name の重みを v にする (物 i)
async function setMorph(page: Page, i: number, name: string, v: number) {
  await page.evaluate(({ i, name, v }) => {
    const { engine } = window as Win;
    const mesh = engine.world.objects[i].model;
    mesh.morphTargetInfluences[mesh.morphTargetDictionary[name]] = v;
    engine.viewport.requestDraw();
  }, { i, name, v });
}

test('仮のコントローラー: 場面にない ray_controller.pmx の Red を setControl で変えると赤くなる (0〜1 に収まる)', async ({ page }) => {
  const errors = await openMme(page);
  const box = await addPmx(page, { flags: 0 });
  expect(await assignFx(page, box, redFrom('ray_controller.pmx', 'Red'))).toBe(true);
  expect(await colorAt(page)).toEqual(BLACK);
  await page.evaluate(() => (window as Win).engine.mme.setControl('ray_controller.pmx', 'Red', 1));
  expect(await colorAt(page)).toEqual(RED);
  await page.evaluate(() => (window as Win).engine.mme.setControl('ray_controller.pmx', 'Red', 7));
  expect(await colorAt(page)).toEqual(RED);
  await page.evaluate(() => (window as Win).engine.mme.setControl('ray_controller.pmx', 'Red', 0));
  expect(await colorAt(page)).toEqual(BLACK);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('(self) のモーフ Green を 1 にすると、その物が緑になる', async ({ page }) => {
  const errors = await openMme(page);
  const box = await addPmx(page, { flags: 0, morphs: ['Green'] });
  expect(await assignFx(page, box, greenFrom('(self)', 'Green'))).toBe(true);
  expect(await colorAt(page)).toEqual(BLACK);
  await setMorph(page, box, 'Green', 1);
  expect(await colorAt(page)).toEqual(GREEN);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('同じ .pmx (モーフ R+) を 2 つ置いて同じ .fx を当てても、モーフを 1 にした物だけ赤くなる', async ({ page }) => {
  const errors = await openMme(page);
  const left = await addPmx(page, { flags: 0, morphs: ['R+'], name: 'Twin', at: [-0.75, 0] });
  const right = await addPmx(page, { flags: 0, morphs: ['R+'], name: 'Twin', at: [0.75, 0] });
  const fx = redFrom('(self)', 'R+');
  expect(await assignFx(page, left, fx)).toBe(true);
  expect(await assignFx(page, right, fx)).toBe(true);
  await setMorph(page, right, 'R+', 1);
  expect(await colorAt(page, -0.75)).toEqual(BLACK);
  expect(await colorAt(page, 0.75)).toEqual(RED);
  await setMorph(page, left, 'R+', 1);
  await setMorph(page, right, 'R+', 0);
  expect(await colorAt(page, -0.75)).toEqual(RED);
  expect(await colorAt(page, 0.75)).toEqual(BLACK);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('名前が合う場面の物 (Ctl.pmx) のモーフと骨の位置を読む。同じ名前なら最初の物', async ({ page }) => {
  const errors = await openMme(page);
  const target = await addPmx(page, { flags: 0, name: 'Target', at: [0, 0] });
  const first = await addPmx(page, { flags: 0, morphs: ['Red'], name: 'Ctl', at: [3, 3] });
  const second = await addPmx(page, { flags: 0, morphs: ['Red'], name: 'Ctl', at: [-3, 3] });
  expect(await assignFx(page, target, redFrom('ctl.pmx', 'Red'))).toBe(true);
  await setMorph(page, second, 'Red', 1);
  expect(await colorAt(page)).toEqual(BLACK); // (2 つ目は見ない)
  await setMorph(page, first, 'Red', 1);
  expect(await colorAt(page)).toEqual(RED);
  // 場面にあるので、仮のコントローラーの値は効かない
  await setMorph(page, first, 'Red', 0);
  await page.evaluate(() => (window as Win).engine.mme.setControl('ctl.pmx', 'Red', 1));
  expect(await colorAt(page)).toEqual(BLACK);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('(self) の骨 Position の位置 (MMD の座標) と、項目なしの bool (隠していなければ 1)', async ({ page }) => {
  const errors = await openMme(page);
  // センターの骨 (置いた x、高さ 0.8) を Position と呼ぶ。x ÷ 2 を赤、高さ ÷ 2 を緑、(self) が見えていれば青
  const box = await addPmx(page, { flags: 0, boneNames: ['Position'], at: [0.5, 0] });
  const fx = objectFx('return float4(P.x * 0.5, P.y * 0.5, V ? 1.0 : 0.0, 1.0);', `
float3 P : CONTROLOBJECT < string name = "(self)"; string item = "Position"; >;
bool V : CONTROLOBJECT < string name = "(self)"; >;`);
  expect(await assignFx(page, box, fx)).toBe(true);
  const [r, g, b] = await colorAt(page, 0.5);
  expect([Math.abs(r - 64) <= 2, Math.abs(g - 102) <= 8, b]).toEqual([true, true, 255]);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('アクセサリの項目 (Si) は警告を出して 0 を渡す', async ({ page }) => {
  const errors = await openMme(page);
  const box = await addPmx(page, { flags: 0 });
  expect(await assignFx(page, box, redFrom('(self)', 'Si'))).toBe(true);
  expect(await colorAt(page)).toEqual(BLACK);
  expect((await warnings(page)).filter(w => w.includes('Si'))).toHaveLength(1);
  expect(errors).toEqual([]);
});

// 場面を写して、仮のコントローラーの Tint (float) を赤に足して canvas に出すポストエフェクト ((self) のない所でも仮のコントローラーは読める)
const TINT_POST = `
float Script : STANDARDSGLOBAL < string ScriptOutput = "color"; string ScriptClass = "scene"; string ScriptOrder = "postprocess"; > = 0.8;
float2 ViewportSize : VIEWPORTPIXELSIZE;
static float2 ViewportOffset = float2(0.5, 0.5) / ViewportSize;
float mTint : CONTROLOBJECT < string name = "ray_controller.pmx"; string item = "Tint"; >;
float4 ClearColor = { 0.0, 0.0, 0.0, 1.0 };
float ClearDepth = 1.0;
texture2D ScnMap : RENDERCOLORTARGET < float2 ViewportRatio = { 1.0, 1.0 }; >;
sampler2D ScnSamp = sampler_state { texture = <ScnMap>; MinFilter = POINT; MagFilter = POINT; MipFilter = NONE; AddressU = CLAMP; AddressV = CLAMP; };
texture2D DepthBuffer : RENDERDEPTHSTENCILTARGET < float2 ViewportRatio = { 1.0, 1.0 }; >;
struct VO { float4 Pos : POSITION; float2 Tex : TEXCOORD0; };
VO VS(float4 Pos : POSITION, float2 Tex : TEXCOORD0) { VO o; o.Pos = Pos; o.Tex = Tex + ViewportOffset; return o; }
float4 Main(float2 Tex : TEXCOORD0) : COLOR0 { float4 c = tex2D(ScnSamp, Tex); return float4(saturate(c.r + mTint), c.gb, 1.0); }
technique Post < string Script = "RenderColorTarget0=ScnMap; RenderDepthStencilTarget=DepthBuffer; ClearSetColor=ClearColor; ClearSetDepth=ClearDepth; Clear=Color; Clear=Depth; ScriptExternal=Color; RenderColorTarget0=; RenderDepthStencilTarget=; Pass=Main;"; > {
  pass Main < string Script = "Draw=Buffer;"; > { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 Main(); }
}`;

test('ポストエフェクトも仮のコントローラーの値を読む', async ({ page }) => {
  const errors = await openMme(page);
  await addPmx(page, { flags: 0 });
  expect(await addPost(page, TINT_POST)).toBe(true);
  await look(page);
  const sky: Vec3 = [0, 2.4, 0];
  expect((await shoot(page, 'png', [sky])).pixels[0]).toEqual(BLACK);
  await page.evaluate(() => (window as Win).engine.mme.setControl('ray_controller.pmx', 'Tint', 1));
  expect((await shoot(page, 'png', [sky])).pixels[0]).toEqual(RED);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});
