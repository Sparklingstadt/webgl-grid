import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from './fixtures/test';
import { choose, open, type Win } from './helpers';
import { addPmx, assignFx, GREEN_FX, objectFx, redFrom, setCamera, shoot, showOffMap, type Vec3 } from './mme-helpers';

// MME 互換の画面: 出力のタブのレンダーエンジン、効果のタブの「MME 互換」の欄 (フォルダから .fx を読む・ポストエフェクトの一覧)

const FACE: Vec3 = [0, 1, 0.2]; // テスト用の .pmx (四角柱) の前の面の真ん中
const SOLID = objectFx('return float4(0.2, 0.4, 0.6, 1.0);'); // 箱の色 (51, 102, 153)

// 場面を写して、PS で色を変えて canvas に出すポストエフェクト
const filterFx = (ps: string, decls = '') => `
${decls}
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
  await expect(panel(page)).toContainText('割り当てはプロジェクトに保存されます');
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
  // (オフ = アクセサリをビューポートでも書き出しでも隠す)
  expect(await page.evaluate(() => (window as Win).engine.mme.posts(true).map((p: Win) => [p.obj.mmeObj.name, !!p.obj.hidden, !!p.obj.hideRender]))).toEqual([['invert.x', true, true], ['half.x', false, false]]);
  // 外す
  await panel(page).getByRole('button', { name: 'Half/half.fx を外す' }).click();
  await expect(rows).toHaveCount(1);
  await expect.poll(() => rgb(page)).toEqual([51, 102, 153]);
  await panel(page).getByRole('button', { name: 'Invert/invert.fx を外す' }).click();
  await expect(panel(page)).toContainText('ポストエフェクトはありません');
  // ポストエフェクトの欄にファイルを落としても足せる (モデルとしては読まない)。落としたら「落とすと読み込みます」は消える
  await page.evaluate(source => {
    const w = window as Win;
    w.__dt = new DataTransfer();
    w.__dt.items.add(new File([source], 'dropped.fx'));
    w.__target = [...document.querySelectorAll('.mme-drop')].find(el => el.textContent?.includes('ポストエフェクトはありません'))!;
    w.__target.dispatchEvent(new DragEvent('dragover', { dataTransfer: w.__dt, bubbles: true, cancelable: true }));
  }, filterFx('return float4(1.0 - c.rgb, 1.0);'));
  await expect(page.locator('.drop-hint')).toHaveCount(1);
  await page.evaluate(() => {
    const w = window as Win;
    w.__target.dispatchEvent(new DragEvent('drop', { dataTransfer: w.__dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.drop-hint')).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('dropped.fx');
  await expect.poll(async () => near(await rgb(page), [204, 153, 102])).toBe(true);
  // (モデルとしては読まない: 物は箱と、ポストエフェクトのアクセサリ)
  expect(await page.evaluate(() => (window as Win).engine.world.objects.map((o: Win) => o.mmeObj?.name ?? null))).toEqual([null, 'dropped.x']);
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

// --- エフェクト割当のタブ (Main とオフスクリーン。物の行と、開くと出る材質の行) と、仮のコントローラーの欄 ---
const assignTabs = (page: Page) => panel(page).getByRole('tablist', { name: 'エフェクト割当' }).getByRole('tab');
// 行 (選択の名前で探す) の、選んでいないときに出る既定のもの (薄い字)
const fallback = (page: Page, select: string) =>
  panel(page).locator('.mme-row').filter({ has: page.getByRole('combobox', { name: select, exact: true }) }).locator('.mme-fallback');
const BOX = 'テスト人形 の .fx';
const BOX_MAT0 = 'テスト人形 の材質 0 の .fx';

test('エフェクト割当: ポストエフェクトを読むと Main とオフスクリーンのタブが出て、オフスクリーンのタブで物を非表示にし、既定に戻せる', async ({ page }, info) => {
  const errors = await boxScene(page);
  const dir = await folder(info.outputPath('Off'), { 'post.fx': showOffMap('*=green.fx;'), 'green.fx': GREEN_FX });
  await page.getByLabel('ポストエフェクトのフォルダを選ぶ').setInputFiles(dir);
  await page.getByRole('dialog', { name: '.fx を選ぶ' }).getByRole('button', { name: 'post.fx', exact: true }).click();
  await expect(assignTabs(page)).toHaveText(['Main', 'OffMap']);
  await expect.poll(() => rgb(page)).toEqual([0, 255, 0]); // (オフスクリーンを画面に出す。物は DefaultEffect の green.fx)
  // Main: 選んでいない行は default.fx
  await expect(assignTabs(page).nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(fallback(page, BOX)).toHaveText('default.fx');
  // オフスクリーンのタブ: Description と、DefaultEffect で決まるもの
  await assignTabs(page).nth(1).click();
  await expect(panel(page)).toContainText('テスト用のマップ');
  await expect(fallback(page, BOX)).toHaveText('Off/green.fx');
  await choose(page, BOX, '非表示');
  await expect.poll(() => rgb(page)).toEqual([0, 0, 255]); // (ClearColor)
  await expect(fallback(page, BOX)).toHaveCount(0);
  expect(await page.evaluate(() => (window as Win).engine.world.objects[0].mme)).toEqual({ OffMap: { object: 'hide' } });
  await choose(page, BOX, '既定に戻す');
  await expect.poll(() => rgb(page)).toEqual([0, 255, 0]);
  await expect(fallback(page, BOX)).toHaveText('Off/green.fx');
  expect(await page.evaluate(() => (window as Win).engine.world.objects[0].mme ?? null)).toBeNull();
  // フォルダの .fx も選べる (Main の割り当ては変えない)
  await choose(page, BOX, 'post.fx');
  expect(await page.evaluate(() => (window as Win).engine.world.objects[0].mme)).toEqual({ OffMap: { object: { folder: 'folder1', path: 'post.fx' } } });
  await choose(page, BOX, '既定に戻す');
  // サイドバーの幅でも横にはみ出さない
  expect(await page.locator('.side-content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('エフェクト割当: DefaultEffect のない共有のオフスクリーンのタブは、割り当てが効かないことを書く', async ({ page }, info) => {
  const errors = await boxScene(page);
  const source = 'shared texture SharedMap : OFFSCREENRENDERTARGET < string Description = "読むだけのマップ"; >;\n' + filterFx('return c;');
  await page.getByLabel('ポストエフェクトのフォルダを選ぶ').setInputFiles(await folder(info.outputPath('Shared'), { 'read.fx': source }));
  await expect(assignTabs(page)).toHaveText(['Main', 'SharedMap']);
  await assignTabs(page).nth(1).click();
  await expect(panel(page)).toContainText('読むだけのマップ');
  await expect(panel(page)).toContainText('このオフスクリーンを描くエフェクトがないので、ここでの割り当ては効きません');
  await expect(panel(page).getByRole('combobox', { name: BOX, exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('エフェクト割当: モデルの行を開くと材質の行が出て、材質に .fx を割り当てられる (材質の行の既定は物の割り当て)', async ({ page }, info) => {
  const errors = await boxScene(page);
  const before = await rgb(page); // (default.fx の色)
  const dir = await folder(info.outputPath('Two'), { 'solid.fx': SOLID, 'red.fx': objectFx('return float4(1.0, 0.0, 0.0, 1.0);') });
  await page.getByLabel('物の .fx のフォルダを選ぶ').setInputFiles(dir);
  await page.getByRole('dialog', { name: '.fx を選ぶ' }).getByRole('button', { name: 'solid.fx', exact: true }).click();
  await expect.poll(() => rgb(page)).toEqual([51, 102, 153]);
  await expect(panel(page).getByRole('combobox', { name: BOX, exact: true })).toContainText('solid.fx');
  // 開くまで材質の行は出ない
  await expect(panel(page).getByRole('combobox', { name: BOX_MAT0, exact: true })).toHaveCount(0);
  const toggle = panel(page).getByRole('button', { name: 'テスト人形 の材質を開く' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(fallback(page, BOX_MAT0)).toHaveText('Two/solid.fx');
  await choose(page, BOX_MAT0, 'red.fx');
  await expect.poll(() => rgb(page)).toEqual([255, 0, 0]);
  expect(await page.evaluate(() => (window as Win).engine.world.objects[0].mme.Main.materials)).toEqual({ 0: { folder: 'folder1', path: 'red.fx' } });
  // 物を既定に戻しても、材質の割り当てが先
  await choose(page, BOX, '既定に戻す');
  await expect.poll(() => rgb(page)).toEqual([255, 0, 0]);
  await choose(page, BOX_MAT0, '既定に戻す');
  await expect.poll(() => rgb(page)).toEqual(before);
  await expect(fallback(page, BOX_MAT0)).toHaveText('default.fx');
  // 閉じると材質の行は消える
  await toggle.click();
  await expect(panel(page).getByRole('combobox', { name: BOX_MAT0, exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// --- 仮のコントローラーの欄 (「置く」と物を選ぶリンク) と、サイドバーの「MME」のページ (選んでいる物の MME の値) ---
const mmeTab = (page: Page) => page.getByRole('tab', { name: 'MME', exact: true });
const tree = (page: Page) => page.getByRole('tree', { name: 'シーンの物' });
const noOverflow = (page: Page) => page.locator('.side-content').evaluate(el => el.scrollWidth <= el.clientWidth);

test('コントローラー: 場面にない名前は「置く」で置け、MME のページの項目のスライダーで色が変わる。◆ でキーを打ち (タイムラインにチャンネル)・消せる', async ({ page }) => {
  const errors = await boxScene(page);
  expect(await assignFx(page, 0, redFrom('ray_controller.pmx', 'Red'))).toBe(true);
  const list = panel(page).getByRole('list', { name: '仮のコントローラーの一覧' });
  await expect(list.getByRole('listitem')).toHaveText(['ray_controller.pmx置く']);
  await expect(mmeTab(page)).toHaveAttribute('aria-selected', 'false');
  await panel(page).getByRole('button', { name: 'ray_controller.pmx を置く' }).click();
  // 置いた物を選び、MME のページを見せる
  expect(await page.evaluate(() => (window as Win).engine.world.objects.map((o: Win) => o.mmeObj?.name ?? null))).toEqual([null, 'ray_controller.pmx']);
  await expect(mmeTab(page)).toHaveAttribute('aria-selected', 'true');
  const slider = page.getByRole('slider', { name: 'Red', exact: true });
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  await expect.poll(() => rgb(page)).toEqual([0, 0, 0]);
  await slider.click(); // (動かさずに押すと数値を打てる)
  const input = page.getByRole('textbox', { name: 'Red (数値)' });
  await input.fill('1');
  await input.press('Enter');
  await expect(slider).toHaveAttribute('aria-valuenow', '1');
  await expect.poll(() => rgb(page)).toEqual([255, 0, 0]);
  expect(await noOverflow(page)).toBe(true);
  // ◆: いまのフレームにキーを打つ。タイムラインのチャンネルに名前が出る
  const key = page.getByRole('button', { name: 'Red のキー' });
  await expect(key).toHaveAttribute('aria-pressed', 'false');
  await key.click();
  await expect(key).toHaveAttribute('aria-pressed', 'true');
  await expect(key).toHaveText('◆');
  await page.getByRole('button', { name: /チャンネル/ }).click();
  expect(await page.evaluate(() => (window as Win).engine.timelineRows().map((r: { label: string }) => r.label))).toEqual(['ray_controller.pmx', 'MME: Red']);
  // もう一度押すと消す
  await key.click();
  await expect(key).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => (window as Win).engine.timelineRows().map((r: { label: string }) => r.label))).toEqual(['ray_controller.pmx']);
  // MME の物は場面の位置を持たない (オブジェクトのタブに位置の欄を出さない)
  await page.getByRole('tab', { name: 'オブジェクト' }).click();
  await expect(page.getByRole('spinbutton', { name: '位置 X' })).toHaveCount(0);
  // 効果のタブ: 場面にある名前は、その物を選ぶリンク
  await tree(page).getByRole('treeitem', { name: 'テスト人形', exact: true }).locator(':scope > .ol-row').click();
  await page.getByRole('tab', { name: '効果' }).click();
  await expect(panel(page).getByRole('button', { name: 'ray_controller.pmx を置く' })).toHaveCount(0);
  await list.getByRole('button', { name: 'ray_controller.pmx', exact: true }).click();
  await expect(mmeTab(page)).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => (window as Win).engine.selection.current?.mmeObj?.name)).toBe('ray_controller.pmx');
  expect(errors).toEqual([]);
});

test('アクセサリ: MME のページの X〜Tr (Si・Tr はスライダーも) で、(self) の Si を読むポストエフェクトの色が変わる', async ({ page }, info) => {
  const errors = await boxScene(page);
  await page.getByLabel('物の .fx のフォルダを選ぶ').setInputFiles(await folder(info.outputPath('Solid'), { 'solid.fx': SOLID }));
  await expect.poll(() => rgb(page)).toEqual([51, 102, 153]);
  const siFx = filterFx('return float4(c.rgb * Si, 1.0);', 'float Si : CONTROLOBJECT < string name = "(self)"; string item = "Si"; >;');
  await page.getByLabel('ポストエフェクトのフォルダを選ぶ').setInputFiles(await folder(info.outputPath('Si'), { 'si.fx': siFx }));
  await expect.poll(() => rgb(page)).toEqual([51, 102, 153]); // (Si の既定は 1)
  await tree(page).getByRole('treeitem', { name: 'si.x', exact: true }).locator(':scope > .ol-row').click();
  await mmeTab(page).click();
  for (const name of ['X', 'Y', 'Z', 'Rx (度)', 'Ry (度)', 'Rz (度)', 'Si', 'Tr']) await expect(page.getByRole('spinbutton', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Si のスライダー' })).toHaveAttribute('aria-valuenow', '1');
  await expect(page.getByRole('slider', { name: 'Tr のスライダー' })).toHaveAttribute('aria-valuenow', '1');
  const si = page.getByRole('spinbutton', { name: 'Si', exact: true });
  await si.click();
  await si.fill('0.5');
  await si.press('Enter');
  await expect.poll(async () => near(await rgb(page), [26, 51, 77])).toBe(true);
  await expect(page.getByRole('slider', { name: 'Si のスライダー' })).toHaveAttribute('aria-valuenow', '0.5');
  expect(await page.evaluate(() => (window as Win).engine.selection.current.mmeValues.Si)).toBe(0.5);
  // 当てた .fx のパラメータ (ベクトルは成分ごとのスライダー)
  const params = page.getByRole('group', { name: 'Si/si.fx' });
  await expect(params.getByRole('slider', { name: /^ClearColor\./ })).toHaveCount(4);
  await expect(params.getByRole('slider', { name: 'ClearDepth', exact: true })).toHaveAttribute('aria-valuenow', '1');
  expect(await noOverflow(page)).toBe(true);
  // 元に戻すと値の欄も戻る
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('slider', { name: 'Si のスライダー' })).toHaveAttribute('aria-valuenow', '1');
  await expect.poll(() => rgb(page)).toEqual([51, 102, 153]);
  expect(errors).toEqual([]);
});

test('モデル: MME のページに当てた .fx のパラメータが出て、色の欄で色が変わる。◆ で全部の成分にキーを打つ', async ({ page }) => {
  const errors = await boxScene(page);
  const colFx = objectFx('return float4(Col, 1.0);', 'float3 Col < string UIName = "色"; string UIWidget = "Color"; > = {1, 0, 0};\nfloat Gain < float UIMin = 0; float UIMax = 2; > = 1;');
  expect(await assignFx(page, 0, colFx, 'col.fx')).toBe(true);
  await expect.poll(() => rgb(page)).toEqual([255, 0, 0]);
  await mmeTab(page).click();
  const params = page.getByRole('group', { name: 'fx/col.fx' });
  await expect(params).toBeVisible();
  await expect(params.getByRole('slider', { name: 'Gain', exact: true })).toHaveAttribute('aria-valuenow', '1');
  // 色の欄 (画面の色のまま .fx に渡す)
  await params.getByRole('button', { name: '色', exact: true }).click();
  const hex = page.getByRole('textbox', { name: '色 (16 進)' });
  await hex.fill('#00ff00');
  await hex.press('Enter');
  await expect.poll(() => rgb(page)).toEqual([0, 255, 0]);
  // ◆: 成分ごとの 3 つのチャンネルに打つ
  await params.getByRole('button', { name: '色 のキー' }).click();
  await expect(params.getByRole('button', { name: '色 のキー' })).toHaveAttribute('aria-pressed', 'true');
  await expect(params.getByRole('button', { name: 'Gain のキー' })).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => {
    const o = (window as Win).engine.world.objects[0];
    return (o.mmeChannels as string[]).filter((_, i) => o.anim?.mme.get(i)?.has(0)).map(n => n.slice(n.indexOf(':')));
  })).toEqual([':Col:x', ':Col:y', ':Col:z']);
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});
