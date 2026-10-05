import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { makePmx } from './fixtures/pmx';
import { expect, test, type Page } from './fixtures/test';
import { uiState, type Win } from './helpers';
import { addPmx, objectFx, openMme, setCamera, shoot } from './mme-helpers';

// 古いプロジェクト (第 4 の計画の形): 場面の値 mme の posts (ポストエフェクトの並びとオン・オフ)・controls (仮のコントローラーの値)・
// stage (名前のないステージの割り当て = ObjectEffects) を持ち、MME の物 (アクセサリ・コントローラー) のない .wgp を、テストの中で
// 第 4 の計画の書式どおりに作って開く。ポストエフェクトはアクセサリ (名前は .fx の拡張子を .x にしたもの。並びとオン・オフはそのまま)、
// 値はコントローラーの物に移り、ステージの割り当ては開いたステージのものになって、移し替えたあとの場面を新しく作って撮った絵と同じになる。
// テスト用の .pmx は 4×20×4 の四角柱 (置くと x, z が ±0.2、高さ 2)。ステージは名前に「ステージ」とあるもの (原点)。カメラは +z から見る

type Ref = { folder: string; path: string };

// 物の .fx: 箱は青、ステージは赤
const BLUE_FX = objectFx('return float4(0.0, 0.0, 1.0, 1.0);');
const RED_FX = objectFx('return float4(1.0, 0.0, 0.0, 1.0);');
// ポストエフェクト: 場面の色 × (0.5 + 0.5 × 仮のコントローラー TestCtrl.pmx の Si)。値が移らなければ (0) 暗くなる
const post = (body: string, decls = '') => `
float Script : STANDARDSGLOBAL < string ScriptOutput = "color"; string ScriptClass = "scene"; string ScriptOrder = "postprocess"; > = 0.8;
float2 ViewportSize : VIEWPORTPIXELSIZE;
static float2 ViewportOffset = float2(0.5, 0.5) / ViewportSize;
float4 ClearColor = { 0.2, 0.2, 0.2, 1.0 };
float ClearDepth = 1.0;
${decls}
texture2D ScnMap : RENDERCOLORTARGET < float2 ViewportRatio = { 1.0, 1.0 }; >;
sampler2D ScnSamp = sampler_state { texture = <ScnMap>; MinFilter = POINT; MagFilter = POINT; MipFilter = NONE; AddressU = CLAMP; AddressV = CLAMP; };
texture2D DepthBuffer : RENDERDEPTHSTENCILTARGET < float2 ViewportRatio = { 1.0, 1.0 }; >;
struct VO { float4 Pos : POSITION; float2 Tex : TEXCOORD0; };
VO VS(float4 Pos : POSITION, float2 Tex : TEXCOORD0) { VO o; o.Pos = Pos; o.Tex = Tex + ViewportOffset; return o; }
float4 Mix(float2 Tex : TEXCOORD0) : COLOR0 { float3 c = tex2D(ScnSamp, Tex).rgb; ${body} }
technique Post < string Script = "RenderColorTarget0=ScnMap; RenderDepthStencilTarget=DepthBuffer; ClearSetColor=ClearColor; ClearSetDepth=ClearDepth; Clear=Color; Clear=Depth; ScriptExternal=Color; RenderColorTarget0=; RenderDepthStencilTarget=; Pass=Mix;"; > {
  pass Mix < string Script = "Draw=Buffer;"; > { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 Mix(); }
}`;
const DIM_FX = post('return float4(c * (0.5 + 0.5 * k), 1.0);', 'float k : CONTROLOBJECT < string name = "TestCtrl.pmx"; string item = "Si"; >;');
// 色を反転するポストエフェクト (オフのまま移らなければ、絵が変わる)
const INVERT_FX = post('return float4(1.0 - c, 1.0);');

const CONTROL = 0.75;
const look = (page: Page) => setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 5, tx: 0.4, ty: 1, tz: 0 });

// フォルダ folder のファイルを読んで entry の参照を返す (コンパイルできなければ null)
async function loadFolder(page: Page, folder: string, files: Record<string, string>, entry: string): Promise<Ref | null> {
  return page.evaluate(async ({ folder, files, entry }) => {
    const { engine } = window as Win;
    const list = Object.entries(files).map(([p, body]) => {
      const f = new File([body], p);
      Object.defineProperty(f, 'webkitRelativePath', { value: `${folder}/${p}` });
      return f;
    });
    const e = await engine.mme.loadEffect(list, entry);
    return e.result.ok ? { folder: e.folder.id as string, path: e.entry as string } : null;
  }, { folder, files, entry });
}

// 移し替えたあとの場面 (いまの形): ステージ (赤)・箱 (青)・コントローラーの物 TestCtrl.pmx (Si)・アクセサリ dim.x (オン) と invert.x (オフ)
async function buildScene(page: Page) {
  await look(page);
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'テストステージ.pmx', mimeType: 'application/octet-stream', buffer: Buffer.from(makePmx('テストステージ', { outward: true, flags: 0 })),
  });
  await expect.poll(() => page.evaluate(() => (window as Win).engine.stage.model !== null)).toBe(true);
  const box = await addPmx(page, { flags: 0, at: [0.8, 0] });
  const fx = { 'red.fx': RED_FX, 'blue.fx': BLUE_FX };
  const red = await loadFolder(page, 'fx', fx, 'red.fx');
  const blue = await loadFolder(page, 'fx', fx, 'blue.fx');
  const posts = { 'dim.fx': DIM_FX, 'invert.fx': INVERT_FX };
  const dim = await loadFolder(page, 'post', posts, 'dim.fx');
  const invert = await loadFolder(page, 'post', posts, 'invert.fx');
  expect([red, blue, dim, invert].every(Boolean)).toBe(true);
  await page.evaluate(({ box, red, blue, dim, invert, control }) => {
    const { engine } = window as Win, { mme } = engine;
    mme.assign(engine.world.objects[box], 'Main', null, blue);
    mme.assignStage('Main', null, red);
    // (古いプロジェクトを開くと、コントローラーの物を先に、アクセサリをポストエフェクトの並びの順に、場面の最後に置く)
    engine.addMmeObject({ kind: 'controller', name: 'TestCtrl.pmx' });
    mme.setControl('TestCtrl.pmx', 'Si', control);
    mme.addPost(mme.store.effect(mme.store.folder(dim.folder), dim.path));
    const off = mme.addPost(mme.store.effect(mme.store.folder(invert.folder), invert.path));
    engine.setVisibility(off, { hidden: true, hideRender: true });
  }, { box, red: red!, blue: blue!, dim: dim!, invert: invert!, control: CONTROL });
  return { red: red!, dim: dim!, invert: invert! };
}

// 書き出した絵の全部の画素 (pixels: ステージと箱の前の面の真ん中の色) と、2 つの絵の画素ごとの RGB の差の最大
const png = async (page: Page) => (await shoot(page, 'png', [[0, 1, 0.2], [0.8, 1, 0.2]], true));
function maxDiff(a: number[], b: number[]) {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

test('第 4 の計画の形のプロジェクト (posts・controls・名前のない stage) を開くと、アクセサリ・コントローラーの物とステージの割り当てに移り、移し替えたあとの場面と同じ絵', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await openMme(page);
  const { red, dim, invert } = await buildScene(page);
  const expected = await png(page);
  // (反転のポストエフェクトはオフ。箱は青 × 0.875、ステージは赤 × 0.875)
  expect(expected.pixels.map(p => p.slice(0, 3))).toEqual([[223, 0, 0], [0, 0, 223]]);

  // いまの形で保存したものから、第 4 の計画の形の .wgp を作る: MME の物を除き (物の値 mmeObj・mmeChannels・mmeValues も、
  // 第 4 の計画にはない)、場面の値 mme を第 4 の計画の書式 { settings, folders, posts, controls, stage } で書く
  const saved = new Uint8Array(await page.evaluate(async () => Array.from(await (window as Win).engine.project.save('embedded'))));
  const zip = unzipSync(saved);
  const data = JSON.parse(strFromU8(zip['project.json']));
  expect(data.objects.map((o: { kind: string }) => o.kind)).toEqual(['model', 'mme', 'mme', 'mme']);
  data.objects = data.objects.filter((o: { kind: string }) => o.kind !== 'mme').map((o: Record<string, unknown>) => {
    const { mmeObj: _obj, mmeChannels: _channels, mmeValues: _values, ...rest } = o;
    return rest;
  });
  data.selected = null;
  data.mme = {
    settings: data.mme.settings,
    folders: data.mme.folders,
    posts: [{ effect: dim, enabled: true }, { effect: invert, enabled: false }],
    controls: { 'TestCtrl.pmx': { Si: CONTROL } },
    stage: { Main: { object: red } },
  };
  const legacy = zipSync({ ...zip, 'project.json': strToU8(JSON.stringify(data)) });

  // 最初の状態に戻して、ファイルの入力から開く
  await page.evaluate(() => (window as Win).engine.resetAll());
  expect(await page.evaluate(() => (window as Win).engine.world.objects.length)).toBe(0);
  await page.locator('input[type=file][accept=".wgp,.wgpj"]').setInputFiles({ name: 'plan4.wgp', mimeType: 'application/zip', buffer: Buffer.from(legacy) });
  await expect.poll(async () => (await uiState(page)).toast, { timeout: 30_000 }).toBe('plan4.wgp を開きました'); // (移し替えで合わないものはない)

  // 移った形: コントローラーの物 (値)・アクセサリ (並びとオン・オフ)・名前の付いたステージの割り当て
  const migrated = await page.evaluate(() => {
    const { engine } = window as Win;
    return {
      objects: engine.world.objects.filter((o: Win) => o.mmeObj).map((o: Win) => ({
        ...o.mmeObj, values: o.mmeValues, hidden: !!o.hidden, hideRender: !!o.hideRender, main: o.mme?.Main?.object ?? null,
      })),
      stage: engine.mme.saveScene().stage,
      posts: engine.mme.saveScene().posts,
    };
  });
  expect(migrated.objects).toEqual([
    { kind: 'controller', name: 'TestCtrl.pmx', values: { Si: CONTROL }, hidden: false, hideRender: false, main: null },
    expect.objectContaining({ kind: 'accessory', name: 'dim.x', hidden: false, hideRender: false, main: dim }),
    expect.objectContaining({ kind: 'accessory', name: 'invert.x', hidden: true, hideRender: true, main: invert }),
  ]);
  expect(migrated.stage).toEqual({ name: 'テストステージ.pmx', effects: { Main: { object: red } } });
  expect(migrated.posts).toBeUndefined(); // (保存するときは、いまの形だけを書く)

  const after = await png(page);
  expect([after.width, after.height]).toEqual([expected.width, expected.height]);
  expect(maxDiff(after.data, expected.data)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => (window as Win).engine.mme.renderer.allWarnings())).toEqual([]);
  expect(errors).toEqual([]);
});
