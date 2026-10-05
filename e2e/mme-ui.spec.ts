import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from './fixtures/test';
import { choose, open, type Win } from './helpers';
import { addPmx, objectFx, setCamera, shoot, type Vec3 } from './mme-helpers';

// MME 互換の画面: 出力のタブのレンダーエンジン、効果のタブの「MME 互換」の欄 (フォルダから .fx を読む・ポストエフェクトの一覧)

const FACE: Vec3 = [0, 1, 0.2]; // テスト用の .pmx (四角柱) の前の面の真ん中
const SOLID = objectFx('return float4(0.2, 0.4, 0.6, 1.0);'); // 箱の色 (51, 102, 153)

// 場面を写して、PS で色を変えて canvas に出すポストエフェクト
const filterFx = (ps: string) => `
float Script : STANDARDSGLOBAL < string ScriptOutput = "color"; string ScriptClass = "scene"; string ScriptOrder = "postprocess"; > = 0.8;
float2 ViewportSize : VIEWPORTPIXELSIZE;
static float2 ViewportOffset = float2(0.5, 0.5) / ViewportSize;
float4 ClearColor = { 0.2, 0.2, 0.2, 1.0 };
float ClearDepth = 1.0;
texture2D ScnMap : RENDERCOLORTARGET < float2 ViewportRatio = { 1.0, 1.0 }; string Format = "A8R8G8B8"; >;
sampler2D ScnSamp = sampler_state { texture = <ScnMap>; MinFilter = POINT; MagFilter = POINT; MipFilter = NONE; AddressU = CLAMP; AddressV = CLAMP; };
texture2D DepthBuffer : RENDERDEPTHSTENCILTARGET < float2 ViewportRatio = { 1.0, 1.0 }; string Format = "D24S8"; >;
struct VO { float4 Pos : POSITION; float2 Tex : TEXCOORD0; };
VO VS(float4 Pos : POSITION, float2 Tex : TEXCOORD0) { VO o; o.Pos = Pos; o.Tex = Tex + ViewportOffset; return o; }
float4 Main(float2 Tex : TEXCOORD0) : COLOR0 { float4 c = tex2D(ScnSamp, Tex); ${ps} }
technique Post < string Script = "RenderColorTarget0=ScnMap; RenderDepthStencilTarget=DepthBuffer; ClearSetColor=ClearColor; ClearSetDepth=ClearDepth; Clear=Color; Clear=Depth; ScriptExternal=Color; RenderColorTarget0=; RenderDepthStencilTarget=; Pass=Main;"; > {
  pass Main < string Script = "Draw=Buffer;"; > { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 Main(); }
}`;

// テストの出力のフォルダの下に、.fx などを入れたフォルダを作る (setInputFiles にフォルダを渡すと webkitRelativePath が付く)
async function folder(dir: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return dir;
}

// 出力のタブでレンダーエンジンを選ぶ
async function setEngine(page: Page, name: '標準' | 'MME 互換') {
  await page.getByRole('tab', { name: '出力' }).click();
  await choose(page, 'レンダーエンジン', name);
}

// MME 互換にして、テスト用の .pmx (箱) を +z から見えるように置いて選ぶ。書き出しは 320×240
async function boxScene(page: Page) {
  const errors = await open(page, { cube: false });
  await page.evaluate(() => (window as Win).engine.output.set({ width: 320, height: 240 }));
  await setEngine(page, 'MME 互換');
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  const i = await addPmx(page, { flags: 0 });
  await page.evaluate(i => { const { engine } = window as Win; engine.selection.select(engine.world.objects[i]); }, i);
  await page.getByRole('tab', { name: '効果' }).click();
  return errors;
}

const rgb = async (page: Page) => (await shoot(page, 'png', [FACE])).pixels[0].slice(0, 3);
const near = (a: number[], b: number[]) => Math.max(...a.map((v, k) => Math.abs(v - b[k]))) <= 2;
const panel = (page: Page) => page.locator('details.panel').filter({ has: page.locator('summary', { hasText: /^MME 互換$/ }) });

test('出力のタブでレンダーエンジンを MME 互換にでき、効果のタブに MME 互換の欄が出る', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('tab', { name: '効果' }).click();
  await expect(panel(page)).toHaveCount(0);
  await page.getByRole('tab', { name: '出力' }).click();
  await expect(page.getByRole('checkbox', { name: 'セルフシャドウ' })).toHaveCount(0);
  await setEngine(page, 'MME 互換');
  const settings = () => page.evaluate(() => ({ ...(window as Win).engine.mme.settings }));
  expect(await settings()).toEqual({ engine: 'mme', selfShadow: true, shadowDistance: 8875, groundShadow: true });
  // セルフシャドウ・影の距離 (0〜9999)・地面の影
  await page.getByRole('checkbox', { name: 'セルフシャドウ' }).click();
  await page.getByRole('spinbutton', { name: '影の距離' }).fill('20000');
  await page.keyboard.press('Enter');
  await page.getByRole('checkbox', { name: '地面の影' }).click();
  expect(await settings()).toEqual({ engine: 'mme', selfShadow: false, shadowDistance: 9999, groundShadow: false });
  await expect(page.getByRole('checkbox', { name: 'セルフシャドウ' })).toHaveAttribute('aria-checked', 'false');
  // 効果のタブに MME 互換の欄 (物を選んでいなければ、選ぶように書く)
  await page.getByRole('tab', { name: '効果' }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText('物を選ぶと、その物に .fx を読み込めます');
  await expect(panel(page)).toContainText('割り当てはページを開き直すと消えます');
  // 標準に戻すと欄は消える
  await setEngine(page, '標準');
  await expect(page.getByRole('checkbox', { name: 'セルフシャドウ' })).toHaveCount(0);
  await page.getByRole('tab', { name: '効果' }).click();
  await expect(panel(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('フォルダを選んで .fx を読み (2 つあれば選ばせる)、選んでいる物に当たる。エラーの一覧を開ける', async ({ page }, info) => {
  const errors = await boxScene(page);
  const before = await rgb(page); // (default.fx の色)
  const dir = await folder(info.outputPath('Fx'), { 'solid.fx': SOLID, 'sub/broken.fx': 'float4 PS( : COLOR0 {', 'tex.png': '' });
  const input = page.getByLabel('物の .fx のフォルダを選ぶ');
  // .fx が 2 つあるので選ばせる (フォルダからの相対パス)
  await input.setInputFiles(dir);
  const dialog = page.getByRole('dialog', { name: '.fx を選ぶ' });
  await expect(dialog.getByRole('button')).toHaveText(['solid.fx', 'sub/broken.fx', 'やめる (Esc)']);
  await page.keyboard.press('x'); // (窓のあいだは、場面のショートカット (X で消す) を効かせない)
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as Win).engine.world.objects.length)).toBe(1);
  await input.setInputFiles(dir);
  await dialog.getByRole('button', { name: 'solid.fx', exact: true }).click();
  await expect(panel(page)).toContainText('Fx/solid.fx');
  await expect(panel(page)).toContainText('コンパイルできました');
  await expect.poll(() => rgb(page)).toEqual([51, 102, 153]);
  // 壊れた .fx: お知らせが出て、エラーの一覧を開ける。モデルは default.fx で描く
  await input.setInputFiles(dir);
  await dialog.getByRole('button', { name: 'sub/broken.fx' }).click();
  await expect(page.getByRole('status')).toContainText('Fx/sub/broken.fx をコンパイルできませんでした');
  const summary = panel(page).getByText(/^コンパイルできませんでした \(エラー \d+・警告 \d+\)$/);
  await expect(summary).toBeVisible();
  const list = panel(page).getByRole('list', { name: 'Fx/sub/broken.fx のエラーと警告' });
  await expect(list).toBeHidden();
  await summary.click();
  await expect(list).toBeVisible();
  await expect(list.getByRole('listitem').first()).toContainText(/^FX-\S+ sub\/broken\.fx:1 /);
  await expect.poll(() => rgb(page)).toEqual(before);
  // 外す
  await panel(page).getByRole('button', { name: '外す', exact: true }).click();
  await expect(panel(page)).toContainText('なし (default.fx で描きます)');
  expect(errors).toEqual([]);
});

test('ポストエフェクトを足し、上下に並べ替え、オフにし、外せる', async ({ page }, info) => {
  const errors = await boxScene(page);
  await page.getByLabel('物の .fx のフォルダを選ぶ').setInputFiles(await folder(info.outputPath('Solid'), { 'solid.fx': SOLID }));
  await expect.poll(() => rgb(page)).toEqual([51, 102, 153]); // (.fx が 1 つなら、選ばせずに読む)
  const add = page.getByLabel('ポストエフェクトのフォルダを選ぶ');
  await add.setInputFiles(await folder(info.outputPath('Invert'), { 'invert.fx': filterFx('return float4(1.0 - c.rgb, 1.0);') }));
  await add.setInputFiles(await folder(info.outputPath('Half'), { 'half.fx': filterFx('return float4(c.rgb * 0.5, 1.0);') }));
  const rows = panel(page).getByRole('list', { name: 'ポストエフェクトの一覧' }).locator(':scope > li');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Invert/invert.fx');
  await expect(rows.nth(1)).toContainText('Half/half.fx');
  // 上のものほど先 (場面の近く) にかかる: 反転してから半分
  await expect.poll(async () => near(await rgb(page), [102, 76, 51])).toBe(true);
  await panel(page).getByRole('button', { name: 'Half/half.fx を上へ' }).click();
  await expect(rows.nth(0)).toContainText('Half/half.fx');
  await expect(panel(page).getByRole('button', { name: 'Half/half.fx を上へ' })).toBeDisabled();
  await expect.poll(async () => near(await rgb(page), [230, 204, 179])).toBe(true); // 半分にしてから反転
  await panel(page).getByRole('button', { name: 'Half/half.fx を下へ' }).click();
  await expect(rows.nth(1)).toContainText('Half/half.fx');
  // 反転をオフに
  await panel(page).getByRole('checkbox', { name: 'Invert/invert.fx を使う' }).click();
  await expect.poll(async () => near(await rgb(page), [26, 51, 77])).toBe(true);
  expect(await page.evaluate(() => (window as Win).engine.mme.store.posts.map((p: Win) => p.enabled))).toEqual([false, true]);
  // 外す
  await panel(page).getByRole('button', { name: 'Half/half.fx を外す' }).click();
  await expect(rows).toHaveCount(1);
  await expect.poll(() => rgb(page)).toEqual([51, 102, 153]);
  await panel(page).getByRole('button', { name: 'Invert/invert.fx を外す' }).click();
  await expect(panel(page)).toContainText('ポストエフェクトはありません');
  // ポストエフェクトの欄にファイルを落としても足せる (モデルとしては読まない)
  await page.evaluate(source => {
    const dt = new DataTransfer();
    dt.items.add(new File([source], 'dropped.fx'));
    const target = [...document.querySelectorAll('.mme-drop')].find(el => el.textContent?.includes('ポストエフェクトはありません'))!;
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, filterFx('return float4(1.0 - c.rgb, 1.0);'));
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('dropped.fx');
  await expect.poll(async () => near(await rgb(page), [204, 153, 102])).toBe(true);
  expect(await page.evaluate(() => (window as Win).engine.world.objects.length)).toBe(1);
  expect(errors).toEqual([]);
});

test('標準に戻すと絵が元どおり (MME 互換にする前の書き出しと同じ画素)', async ({ page }, info) => {
  const errors = await open(page, { cube: false });
  await page.evaluate(() => (window as Win).engine.output.set({ width: 320, height: 240 }));
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  const i = await addPmx(page, { flags: 0 });
  await page.evaluate(i => { const { engine } = window as Win; engine.selection.select(engine.world.objects[i]); }, i);
  const image = async () => (await shoot(page, 'png', [], true)).data;
  const standard = await image();
  // MME 互換で .fx とポストエフェクトを使って描く
  await setEngine(page, 'MME 互換');
  await page.getByRole('tab', { name: '効果' }).click();
  await page.getByLabel('物の .fx のフォルダを選ぶ').setInputFiles(await folder(info.outputPath('Solid'), { 'solid.fx': SOLID }));
  await page.getByLabel('ポストエフェクトのフォルダを選ぶ').setInputFiles(await folder(info.outputPath('Invert'), { 'invert.fx': filterFx('return float4(1.0 - c.rgb, 1.0);') }));
  await expect.poll(() => rgb(page)).toEqual([204, 153, 102]);
  expect(await image()).not.toEqual(standard);
  // 標準に戻すと、MME の資源を片付けて、前と同じ絵
  await setEngine(page, '標準');
  expect(await page.evaluate(() => (window as Win).engine.mme.renderer.instances.size)).toBe(0);
  expect(await image()).toEqual(standard);
  expect(errors).toEqual([]);
});
