import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { expect, test, type Page } from './fixtures/test';
import { uiState, type Win } from './helpers';
import { addPmx, objectFx, openMme, redBluePng, setCamera, shoot } from './mme-helpers';

// MME 互換の保存と開く: フォルダ・物とオフスクリーンのタブの割り当て・ポストエフェクト・仮のコントローラーの値と、実際に読んだ .fx と画像を
// プロジェクトに入れ (.wgp) / 参照し (.wgpj)、最初の状態に戻してから開くと、同じ絵になる。
// テスト用の .pmx は 4×20×4 の四角柱 (置くと x, z が ±0.2、高さ 2)。カメラは +z から見る

type Ref = { folder: string; path: string };
type Files = Record<string, string>; // パス → 中身 (画像は 'base64:…')

// 物の .fx: 画像 tex.png を、画面の位置で貼る (上半分が赤・下半分が青)
const TEX_FX = objectFx('return tex2D(TexSamp, vpos / ViewportSize);', `
float2 ViewportSize : VIEWPORTPIXELSIZE;
texture Tex < string ResourceName = "tex.png"; >;
sampler TexSamp = sampler_state { texture = <Tex>; MinFilter = POINT; MagFilter = POINT; MipFilter = NONE; AddressU = CLAMP; AddressV = CLAMP; };`)
  .replace('float4 PS(float2 Uv : TEXCOORD0)', 'float4 PS(float2 Uv : TEXCOORD0, float2 vpos : VPOS)');
// 物の .fx: 画像 off.png の上半分 (赤) の色
const OFF_TEX_FX = objectFx('return tex2D(TexSamp, float2(0.5, 0.25));', `
texture Tex < string ResourceName = "off.png"; >;
sampler TexSamp = sampler_state { texture = <Tex>; MinFilter = POINT; MagFilter = POINT; MipFilter = NONE; AddressU = CLAMP; AddressV = CLAMP; };`);
const GREEN_FX = objectFx('return float4(0.0, 1.0, 0.0, 1.0);');

// ポストエフェクト: 場面の色の半分と、オフスクリーン OffMap (DefaultEffect は defaultEffect。何もない所は黒) の色の半分 × 仮のコントローラー
// TestCtrl.pmx の Si の値 (control が false なら 1)
const postFx = (defaultEffect: string, control = true) => `
float Script : STANDARDSGLOBAL < string ScriptOutput = "color"; string ScriptClass = "scene"; string ScriptOrder = "postprocess"; > = 0.8;
float2 ViewportSize : VIEWPORTPIXELSIZE;
static float2 ViewportOffset = float2(0.5, 0.5) / ViewportSize;
float4 ClearColor = { 0.2, 0.2, 0.2, 1.0 };
float ClearDepth = 1.0;
${control ? 'float k : CONTROLOBJECT < string name = "TestCtrl.pmx"; string item = "Si"; >;' : 'static float k = 1.0;'}
texture2D ScnMap : RENDERCOLORTARGET < float2 ViewportRatio = { 1.0, 1.0 }; >;
sampler2D ScnSamp = sampler_state { texture = <ScnMap>; MinFilter = POINT; MagFilter = POINT; MipFilter = NONE; AddressU = CLAMP; AddressV = CLAMP; };
texture2D DepthBuffer : RENDERDEPTHSTENCILTARGET < float2 ViewportRatio = { 1.0, 1.0 }; >;
texture OffMap : OFFSCREENRENDERTARGET <
  string Description = "テスト用のマップ";
  float2 ViewportRatio = { 1.0, 1.0 };
  float4 ClearColor = { 0, 0, 0, 1 };
  float ClearDepth = 1.0;
  string DefaultEffect = "${defaultEffect}";
>;
sampler2D OffSamp = sampler_state { texture = <OffMap>; MinFilter = POINT; MagFilter = POINT; MipFilter = NONE; AddressU = CLAMP; AddressV = CLAMP; };
struct VO { float4 Pos : POSITION; float2 Tex : TEXCOORD0; };
VO VS(float4 Pos : POSITION, float2 Tex : TEXCOORD0) { VO o; o.Pos = Pos; o.Tex = Tex + ViewportOffset; return o; }
float4 Mix(float2 Tex : TEXCOORD0) : COLOR0 { return float4(tex2D(ScnSamp, Tex).rgb * 0.5 + tex2D(OffSamp, Tex).rgb * 0.5 * k, 1.0); }
technique Post < string Script = "RenderColorTarget0=ScnMap; RenderDepthStencilTarget=DepthBuffer; ClearSetColor=ClearColor; ClearSetDepth=ClearDepth; Clear=Color; Clear=Depth; ScriptExternal=Color; RenderColorTarget0=; RenderDepthStencilTarget=; Pass=Mix;"; > {
  pass Mix < string Script = "Draw=Buffer;"; > { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 Mix(); }
}`;

const look = (page: Page) => setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, tx: 0, ty: 1, tz: 0 });

// フォルダ folder のファイルを読んで entry をコンパイルし、割り当てに使う参照を返す (コンパイルできなければ null)
async function loadFolder(page: Page, folder: string, files: Files, entry: string): Promise<Ref | null> {
  return page.evaluate(async ({ folder, files, entry }) => {
    const { engine } = window as Win;
    const list = Object.entries(files).map(([p, body]) => {
      const bytes = body.startsWith('base64:') ? Uint8Array.from(atob(body.slice(7)), c => c.charCodeAt(0)) : body;
      const f = new File([bytes], p.slice(p.lastIndexOf('/') + 1));
      Object.defineProperty(f, 'webkitRelativePath', { value: `${folder}/${p}` });
      return f;
    });
    const e = await engine.mme.loadEffect(list, entry);
    return e.result.ok ? { folder: e.folder.id, path: e.entry } : null;
  }, { folder, files, entry });
}

// 開くときに選ぶファイル (フォルダの中のファイルを、名前だけで)
const pickable = (files: Files) => Object.entries(files).map(([p, body]) => ({
  name: p.slice(p.lastIndexOf('/') + 1), mimeType: 'application/octet-stream',
  buffer: body.startsWith('base64:') ? Buffer.from(body.slice(7), 'base64') : Buffer.from(body),
}));

// 書き出した絵の全部の画素
const png = async (page: Page) => (await shoot(page, 'png', [], true));
// 2 つの絵の、画素ごとの RGB の差の最大
function maxDiff(a: number[], b: number[]) {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}
// 絵の (x, y) (幅・高さに対する割合) の画素
const pixelAt = (r: { width: number; height: number; data: number[] }, fx: number, fy: number) => {
  const i = (Math.floor(r.height * fy) * r.width + Math.floor(r.width * fx)) * 4;
  return r.data.slice(i, i + 4);
};

// 場面: 箱に画像を貼る .fx (フォルダ fx)、オフスクリーンのタブで箱を緑にする割り当て、ポストエフェクト (フォルダ post)、仮のコントローラーの値
async function buildScene(page: Page) {
  const fx: Files = { 'obj.fx': TEX_FX, 'green.fx': GREEN_FX, 'tex.png': `base64:${await redBluePng(page)}` };
  const post: Files = { 'post.fx': postFx('*=hide;') };
  await look(page);
  const box = await addPmx(page, { flags: 0 });
  const obj = await loadFolder(page, 'fx', fx, 'obj.fx');
  const off = await loadFolder(page, 'fx', fx, 'green.fx');
  const mix = await loadFolder(page, 'post', post, 'post.fx');
  expect([obj, off, mix].every(Boolean)).toBe(true);
  await page.evaluate(({ box, obj, off, mix }) => {
    const { engine } = window as Win, { mme } = engine;
    const o = engine.world.objects[box];
    mme.assign(o, 'Main', null, obj);
    mme.assign(o, 'OffMap', null, off);
    mme.addPost(mme.store.effect(mme.store.folder(mix.folder), mix.path));
    engine.addMmeObject({ kind: 'controller', name: 'TestCtrl.pmx' });
    mme.setControl('TestCtrl.pmx', 'Si', 0.75);
  }, { box, obj: obj!, off: off!, mix: mix! });
  return { fx, post };
}

// 最初の状態に戻して、ファイルの入力から開く。開き終わるまで待つ
async function resetAndOpen(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.evaluate(() => (window as Win).engine.resetAll());
  expect(await page.evaluate(() => (window as Win).engine.mme.store.folders().length)).toBe(0);
  await page.locator('input[type=file][accept=".wgp,.wgpj"]').setInputFiles(file);
}
const opened = (page: Page, name: string) => expect.poll(async () => (await uiState(page)).toast, { timeout: 30_000 }).toBe(`${name} を開きました`);

test('.wgp: 割り当て・オフスクリーンのタブ・ポストエフェクト・コントローラーの値と、読んだ .fx と画像を入れ、開き直すと同じ絵', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await openMme(page);
  await buildScene(page);
  const before = await png(page);
  // (画像を貼った箱 (上は赤) に、オフスクリーンの緑 × 0.75 を重ねている)
  const [r, g, b] = pixelAt(before, 0.5, 0.4);
  expect([Math.abs(r - 128) <= 3, Math.abs(g - 96) <= 3, b <= 3]).toEqual([true, true, true]);

  await page.getByRole('button', { name: 'ファイル' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'プロジェクトを保存' }).click()]);
  const bytes = await readFile((await download.path())!);
  const data = JSON.parse(strFromU8(unzipSync(new Uint8Array(bytes))['project.json']));
  expect(data.mmeFiles.map((m: { path: string }) => m.path).sort()).toEqual(['green.fx', 'obj.fx', 'post.fx', 'tex.png']);
  expect(data.mme.controls).toBeUndefined(); // (コントローラーの値は物の値)
  expect(data.mme.posts).toBeUndefined(); // (ポストエフェクトはアクセサリの物の割り当て)
  expect(data.objects.filter((o: { kind: string }) => o.kind === 'mme').map((o: { mmeObj: unknown; mmeValues: unknown }) => [o.mmeObj, o.mmeValues]))
    .toEqual([
      [{ kind: 'accessory', name: 'post.x' }, { X: 0, Y: 0, Z: 0, Rx: 0, Ry: 0, Rz: 0, Si: 1, Tr: 1 }],
      [{ kind: 'controller', name: 'TestCtrl.pmx' }, { Si: 0.75 }],
    ]);

  await resetAndOpen(page, { name: 'mme.wgp', mimeType: 'application/zip', buffer: bytes });
  await opened(page, 'mme.wgp');
  const after = await png(page);
  expect([after.width, after.height]).toEqual([before.width, before.height]);
  expect(maxDiff(after.data, before.data)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => (window as Win).engine.mme.renderer.allWarnings())).toEqual([]);
  expect(errors).toEqual([]);
});

test('.wgpj: ファイルは参照だけにして、開くときに足りない .fx と画像を選ぶと、同じ絵', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await openMme(page);
  const { fx, post } = await buildScene(page);
  const before = await png(page);

  await page.getByRole('button', { name: 'ファイル' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /参照だけで保存/ }).click()]);
  const json = await readFile((await download.path())!);

  // (.pmx はこのページで読んだので探さない。最初の状態に戻すと読み込んだフォルダは消えるので、.fx と画像を探してもらう)
  await resetAndOpen(page, { name: 'mme.wgpj', mimeType: 'application/json', buffer: json });
  const dialog = page.getByRole('dialog', { name: 'ファイルを探す' });
  await expect(dialog.getByRole('list', { name: '見つからないファイル' }).getByRole('listitem')).toHaveCount(4);
  await dialog.getByLabel('ファイルを選ぶ').setInputFiles([...pickable(fx), ...pickable(post)]);
  await expect(dialog).toHaveCount(0);
  await opened(page, 'mme.wgpj');
  const after = await png(page);
  expect(maxDiff(after.data, before.data)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('割り当ててすぐ (描く前に) .wgp に保存しても、オフスクリーンの DefaultEffect で描く .fx の画像まで入り、開き直すと画像がある', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await openMme(page);
  await look(page);
  const box = await addPmx(page, { flags: 0 });
  const image = `base64:${await redBluePng(page)}`;
  const files: Files = { 'obj.fx': TEX_FX, 'tex.png': image, 'post.fx': postFx('*=sub/offtex.fx;', false), 'sub/offtex.fx': OFF_TEX_FX, 'sub/off.png': image };
  // (標準のエンジンのあいだに、読んで割り当ててすぐ保存する。MME 互換では描かないので、画像は保存の前に読むものだけ)
  const saved = await page.evaluate(async ({ box, files }) => {
    const { engine } = window as Win, { mme } = engine;
    mme.set({ engine: 'standard' });
    const list = Object.entries(files).map(([p, body]) => {
      const bytes = body.startsWith('base64:') ? Uint8Array.from(atob(body.slice(7)), c => c.charCodeAt(0)) : body;
      const f = new File([bytes], p.slice(p.lastIndexOf('/') + 1));
      Object.defineProperty(f, 'webkitRelativePath', { value: `post/${p}` });
      return f;
    });
    const post = await mme.loadEffect(list, 'post.fx');
    mme.addPost(post);
    mme.assign(engine.world.objects[box], 'Main', null, { folder: post.folder.id, path: 'obj.fx' });
    const bytes: Uint8Array = await engine.project.save('embedded');
    mme.set({ engine: 'mme' });
    return Array.from(bytes);
  }, { box, files });
  const bytes = Buffer.from(saved);
  const data = JSON.parse(strFromU8(unzipSync(new Uint8Array(bytes))['project.json']));
  expect(data.mmeFiles.map((m: { path: string }) => m.path).sort()).toEqual(['obj.fx', 'post.fx', 'sub/off.png', 'sub/offtex.fx', 'tex.png']);
  const before = await png(page);
  // (箱の上のほうは、Main (tex.png の上半分) でもオフスクリーン (off.png の上半分) でも赤)
  expect(pixelAt(before, 0.5, 0.4).slice(0, 3)).toEqual([255, 0, 0]);

  await resetAndOpen(page, { name: 'quick.wgp', mimeType: 'application/zip', buffer: bytes });
  await opened(page, 'quick.wgp');
  await page.evaluate(() => (window as Win).engine.mme.set({ engine: 'mme' })); // (標準のエンジンで保存した)
  const after = await png(page);
  expect(pixelAt(after, 0.5, 0.4).slice(0, 3)).toEqual([255, 0, 0]);
  expect(maxDiff(after.data, before.data)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('第 2 の計画の形の mme (設定だけ) のプロジェクトを開いても、エラーのお知らせが出ない', async ({ page }) => {
  const errors = await openMme(page);
  const json = await page.evaluate(async () => {
    const data = JSON.parse(new TextDecoder().decode(await (window as Win).engine.project.save('reference')));
    data.mme = { engine: 'mme', selfShadow: false, shadowDistance: 5000, groundShadow: true };
    delete data.mmeFiles;
    return JSON.stringify(data);
  });
  await resetAndOpen(page, { name: 'old.wgpj', mimeType: 'application/json', buffer: Buffer.from(json) });
  await opened(page, 'old.wgpj');
  expect(await page.evaluate(() => (window as Win).engine.mme.settings)).toEqual({ engine: 'mme', selfShadow: false, shadowDistance: 5000, groundShadow: true });
  expect(errors).toEqual([]);
});
