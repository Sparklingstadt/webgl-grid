import { expect, test, type Page } from './fixtures/test';
import { addPmx, GREEN_FX, objectFx, openMme, setCamera, shoot, showOffMap, type Vec3 } from './mme-helpers';
import type { Win } from './helpers';

// MME 互換の OFFSCREENRENDERTARGET: ポストエフェクトや物の .fx が宣言したオフスクリーンに、そのタブの割り当て表 (割り当て →
// DefaultEffect) で物を描く。入れ子のオフスクリーンは持ち主ごと。
// テスト用の .pmx は 4×20×4 の四角柱 (置くと x, z が ±0.2、高さ 2)。カメラは +z から見る。
// (shoot の点を写す射影は、横には書き出しの絵とずれることがあるので、見る物はカメラの注視点の真下に置いて真ん中の画素を見る)

type Ref = { folder: string; path: string };
const GREEN = [0, 255, 0, 255], BLUE = [0, 0, 255, 255], RED = [255, 0, 0, 255], WHITE = [255, 255, 255, 255];
const face = (x = 0, z = 0, y = 1): Vec3 => [x, y, z + 0.2]; // 箱の前の面

// フォルダ folder の文字のファイル (パス → 中身) を読んで entry をコンパイルし、割り当てに使う参照を返す (コンパイルできなければ null)
async function loadFx(page: Page, folder: string, files: Record<string, string>, entry: string): Promise<Ref | null> {
  return page.evaluate(async ({ folder, files, entry }) => {
    const { engine } = window as Win;
    const list = Object.entries(files).map(([p, text]) => {
      const f = new File([text], p.slice(p.lastIndexOf('/') + 1));
      Object.defineProperty(f, 'webkitRelativePath', { value: `${folder}/${p}` });
      return f;
    });
    const e = await engine.mme.loadEffect(list, entry);
    return e.result.ok ? { folder: e.folder.id, path: e.entry } : null;
  }, { folder, files, entry });
}

// 物 i のタブ tab の、物全体 (material が null) か材質の割り当てを変える (slot が null なら外す)
async function assign(page: Page, i: number, tab: string, material: number | null, slot: Ref | 'hide' | null) {
  await page.evaluate(({ i, tab, material, slot }) => {
    const { engine } = window as Win;
    engine.mme.assign(engine.world.objects[i], tab, material, slot);
  }, { i, tab, material, slot });
}

async function addPostRef(page: Page, ref: Ref) {
  await page.evaluate(ref => {
    const { store } = (window as Win).engine.mme;
    store.addPost(store.effect(store.folder(ref.folder), ref.path));
  }, ref);
}

const warnings = (page: Page) => page.evaluate(() => (window as Win).engine.mme.renderer.allWarnings() as string[]);
const look = (page: Page, x = 0, z = 0) => setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, tx: x, ty: 1, tz: z });

const WHITE_FX = objectFx('return float4(1.0, 1.0, 1.0, 1.0);');

// 物の .fx: 自分のオフスクリーン Mine (何もない所は ClearColor) の、いま描いている画素の所を出す
const nestFx = (defaultEffect: string, clear = '1, 0, 0, 1') => `
float4x4 WVP : WORLDVIEWPROJECTION;
float2 ViewportSize : VIEWPORTPIXELSIZE;
texture Mine : OFFSCREENRENDERTARGET < float2 ViewportRatio = { 1.0, 1.0 }; float4 ClearColor = { ${clear} }; float ClearDepth = 1.0; string DefaultEffect = "${defaultEffect}"; >;
sampler MineSamp = sampler_state { texture = <Mine>; MinFilter = POINT; MagFilter = POINT; MipFilter = NONE; AddressU = CLAMP; AddressV = CLAMP; };
float4 VS(float4 Pos : POSITION) : POSITION { return mul(Pos, WVP); }
float4 PS(float2 vpos : VPOS) : COLOR0 { return tex2D(MineSamp, (vpos + 0.5) / ViewportSize); }
technique T < string MMDPass = "object"; > { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }`;

// 物の世界の位置 (MMD の x) が負なら赤、正なら緑で描く .fx
// 頂点の世界の x の符号で赤か緑 (MMD モデルの WORLD は MMD と同じく単位行列なので、物の原点ではなく頂点の位置で見る)
const SIDE_FX = `
float4x4 WVP : WORLDVIEWPROJECTION;
float4x4 W : WORLD;
struct VO { float4 Pos : POSITION; float X : TEXCOORD0; };
VO VS(float4 Pos : POSITION) { VO o; o.Pos = mul(Pos, WVP); o.X = mul(Pos, W).x; return o; }
float4 PS(float X : TEXCOORD0) : COLOR0 { return X < 0 ? float4(1, 0, 0, 1) : float4(0, 1, 0, 1); }
technique T < string MMDPass = "object"; > { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }`;

test('ポストエフェクトのオフスクリーン: DefaultEffect = "*=green.fx;" で物を緑に描き、何もない所は ClearColor', async ({ page }) => {
  const errors = await openMme(page);
  await look(page);
  await addPmx(page, { flags: 0 });
  const post = await loadFx(page, 'post', { 'post.fx': showOffMap('*=green.fx;'), 'green.fx': GREEN_FX }, 'post.fx');
  expect(post).not.toBeNull();
  await addPostRef(page, post!);
  const r = await shoot(page, 'png', [face(), [0, 2.4, 0]]);
  expect(r.pixels).toEqual([GREEN, BLUE]);
  expect(await page.evaluate(() => (window as Win).engine.mme.renderer.offscreenTabs())).toEqual([{ name: 'OffMap', description: 'テスト用のマップ' }]);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('DefaultEffect = "Cube*=hide; *=green.fx;": 名前 (.pmx のファイル名) が Cube で始まる物は描かない', async ({ page }) => {
  const errors = await openMme(page);
  await addPmx(page, { flags: 0, name: 'CubeBox', at: [-0.75, 0] });
  await addPmx(page, { flags: 0, name: 'Doll', at: [0.75, 0] });
  const post = await loadFx(page, 'post', { 'post.fx': showOffMap('Cube*=hide; *=green.fx;'), 'green.fx': GREEN_FX }, 'post.fx');
  await addPostRef(page, post!);
  await look(page, -0.75);
  expect((await shoot(page, 'png', [face(-0.75)])).pixels).toEqual([BLUE]);
  await look(page, 0.75);
  expect((await shoot(page, 'png', [face(0.75)])).pixels).toEqual([GREEN]);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('オフスクリーンのタブの割り当て: 物を hide にするとその物だけ消え、材質ごとの割り当ても効く。外すと DefaultEffect に戻る', async ({ page }) => {
  const errors = await openMme(page);
  // 前の面の左上の三角形だけを材質 1 に、ほかを材質 0 にした箱と、ふつうの箱
  const inward = [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7, 4, 5, 6, 4, 6, 7, 0, 2, 1, 0, 3, 2];
  const outward = inward.map((_, k) => inward[k % 3 === 0 ? k : k % 3 === 1 ? k + 1 : k - 1]);
  const parts = [{ faces: [...outward.slice(0, 3), ...outward.slice(6)], edgeSize: 0 }, { faces: outward.slice(3, 6), edgeSize: 0 }];
  const split = await addPmx(page, { flags: 0, parts, name: 'Split', at: [-0.75, 0] });
  const plain = await addPmx(page, { flags: 0, name: 'Plain', at: [0.75, 0] });
  const post = await loadFx(page, 'post', { 'post.fx': showOffMap('*=green.fx;'), 'green.fx': GREEN_FX, 'white.fx': WHITE_FX }, 'post.fx');
  await addPostRef(page, post!);
  // 前の面の下の真ん中 (材質 0) と上の真ん中 (材質 1)
  const halves = (x: number): Vec3[] => [face(x, 0, 0.2), face(x, 0, 1.8)];
  const at = async (x: number) => { await look(page, x); return (await shoot(page, 'png', halves(x))).pixels; };
  expect(await at(-0.75)).toEqual([GREEN, GREEN]);
  await assign(page, plain, 'OffMap', null, 'hide');
  expect(await at(0.75)).toEqual([BLUE, BLUE]);
  expect(await at(-0.75)).toEqual([GREEN, GREEN]); // (ほかの物はそのまま)
  // 材質 1 だけ hide、材質 0 だけ white.fx (物の割り当てより材質の割り当て)
  await assign(page, split, 'OffMap', 1, 'hide');
  expect(await at(-0.75)).toEqual([GREEN, BLUE]);
  await assign(page, split, 'OffMap', null, 'hide');
  await assign(page, split, 'OffMap', 0, { folder: post!.folder, path: 'white.fx' });
  expect(await at(-0.75)).toEqual([WHITE, BLUE]);
  // 外すと DefaultEffect に戻る
  await assign(page, plain, 'OffMap', null, null);
  expect(await at(0.75)).toEqual([GREEN, GREEN]);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('入れ子: 物の .fx のオフスクリーンの DefaultEffect = "self=hide; *=white.fx;" では、持ち主は入らず、ほかの物は白', async ({ page }) => {
  const errors = await openMme(page);
  await look(page);
  const front = await addPmx(page, { flags: 0, name: 'Front', at: [0, 0] });
  await addPmx(page, { flags: 0, name: 'Behind', at: [0, -1.5] }); // (前の箱の真後ろ。上の端は前の箱より低く見える)
  const nest = await loadFx(page, 'fx', { 'nest.fx': nestFx('self=hide; *=white.fx;'), 'white.fx': WHITE_FX }, 'nest.fx');
  await assign(page, front, 'Main', null, nest);
  // 前の箱の真ん中: 自分のオフスクリーンでは自分がいないので、後ろの箱 (白) が見える。上の端: 後ろに何もないので ClearColor (赤)
  expect((await shoot(page, 'png', [face(), face(0, 0, 1.95)])).pixels).toEqual([WHITE, RED]);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('同じ .fx を当てた物 2 つは、それぞれ自分のオフスクリーンを持つ (持ち主の位置で色が変わる)', async ({ page }) => {
  const errors = await openMme(page);
  const left = await addPmx(page, { flags: 0, name: 'Left', at: [-0.75, 0] });
  const right = await addPmx(page, { flags: 0, name: 'Right', at: [0.75, 0] });
  // 自分のオフスクリーンには自分だけを、位置で色を変える .fx で描く (左は赤、右は緑。何もない所は青)
  const nest = await loadFx(page, 'fx', { 'nest.fx': nestFx('self=side.fx; *=hide;', '0, 0, 1, 1'), 'side.fx': SIDE_FX }, 'nest.fx');
  await assign(page, left, 'Main', null, nest);
  await assign(page, right, 'Main', null, nest);
  await look(page, -0.75);
  expect((await shoot(page, 'png', [face(-0.75)])).pixels).toEqual([RED]);
  await look(page, 0.75);
  expect((await shoot(page, 'png', [face(0.75)])).pixels).toEqual([GREEN]);
  expect(await warnings(page)).toEqual([]);
  expect(errors).toEqual([]);
});
