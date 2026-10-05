import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { makePmx } from './fixtures/pmx';
import { expect, test, type Page } from './fixtures/test';
import { choose, uiState, type Win } from './helpers';
import { GREEN_FX, objectFx, openMme, setCamera, shoot, showOffMap, type Vec3 } from './mme-helpers';

// MME 互換のステージの割り当て (場面の値 MmeScene.stage): エフェクト割当のどのタブにもステージの行が出て、Main で .fx を割り当てると
// その .fx で描き、オフスクリーンのタブで非表示にするとそのオフスクリーンに入らない。プロジェクトに保存して開き直すと戻る。
// ステージは名前に「ステージ」とあるテスト用の .pmx (4×20×4 の四角柱。原点に置くと x, z が ±0.2、高さ 2)。カメラは +z から見る

const FACE: Vec3 = [0, 1, 0.2]; // 四角柱の前の面の真ん中
const STAGE_ROW = 'ステージ: テストステージ.pmx の .fx';
const RED_FX = objectFx('return float4(1.0, 0.0, 0.0, 1.0);');

const panel = (page: Page) => page.locator('details.panel').filter({ has: page.locator('summary', { hasText: /^MME 互換$/ }) });
const assignTabs = (page: Page) => panel(page).getByRole('tablist', { name: 'エフェクト割当' }).getByRole('tab');
const fallback = (page: Page, select: string) =>
  panel(page).locator('.mme-row').filter({ has: page.getByRole('combobox', { name: select, exact: true }) }).locator('.mme-fallback');
const rgb = async (page: Page) => (await shoot(page, 'png', [FACE])).pixels[0].slice(0, 3);

// ステージを読み込み (ファイルの入力から)、+z から見る
async function stageScene(page: Page) {
  const errors = await openMme(page);
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'テストステージ.pmx', mimeType: 'application/octet-stream', buffer: Buffer.from(makePmx('テストステージ', { outward: true, flags: 0 })),
  });
  await expect.poll(() => page.evaluate(() => (window as Win).engine.stage.model !== null)).toBe(true);
  expect(await page.evaluate(() => (window as Win).engine.world.objects.length)).toBe(0);
  await page.getByRole('tab', { name: '効果' }).click();
  return errors;
}

// フォルダ folder のファイルを読み、entry の参照を返す
async function loadFolder(page: Page, folder: string, files: Record<string, string>, entry: string) {
  return page.evaluate(async ({ folder, files, entry }) => {
    const { engine } = window as Win;
    const list = Object.entries(files).map(([p, body]) => {
      const f = new File([body], p);
      Object.defineProperty(f, 'webkitRelativePath', { value: `${folder}/${p}` });
      return f;
    });
    const e = await engine.mme.loadEffect(list, entry);
    return { folder: e.folder.id as string, path: e.entry as string, ok: e.result.ok as boolean };
  }, { folder, files, entry });
}

test('ステージの行: Main で .fx を割り当てるとその .fx で描き、オフスクリーンのタブで非表示にすると入らない', async ({ page }) => {
  const errors = await stageScene(page);
  const before = await rgb(page); // (default.fx)
  const red = await loadFolder(page, 'fx', { 'red.fx': RED_FX }, 'red.fx');
  expect(red.ok).toBe(true);
  // Main: ステージの行 (先頭) の既定は default.fx。.fx を選ぶとその色
  await expect(fallback(page, STAGE_ROW)).toHaveText('default.fx');
  await choose(page, STAGE_ROW, 'red.fx');
  await expect.poll(() => rgb(page)).toEqual([255, 0, 0]);
  expect(await page.evaluate(() => (window as Win).engine.mme.saveScene().stage)).toEqual({ Main: { object: { folder: red.folder, path: 'red.fx' } } });
  await choose(page, STAGE_ROW, '既定に戻す');
  await expect.poll(() => rgb(page)).toEqual(before);

  // オフスクリーン: ポストエフェクトの OffMap (DefaultEffect = *=green.fx;) にステージは緑で入る。非表示にすると ClearColor (青)
  const post = await loadFolder(page, 'post', { 'post.fx': showOffMap('*=green.fx;'), 'green.fx': GREEN_FX }, 'post.fx');
  expect(post.ok).toBe(true);
  await page.evaluate(p => { const { mme } = (window as Win).engine; mme.addPost(mme.store.effect(mme.store.folder(p.folder), p.path)); }, post);
  await expect.poll(() => rgb(page)).toEqual([0, 255, 0]);
  await expect(assignTabs(page)).toHaveText(['Main', 'OffMap']);
  await assignTabs(page).nth(1).click();
  await expect(fallback(page, STAGE_ROW)).toHaveText('post/green.fx');
  await choose(page, STAGE_ROW, '非表示');
  await expect.poll(() => rgb(page)).toEqual([0, 0, 255]);
  expect(await page.evaluate(() => (window as Win).engine.mme.saveScene().stage)).toEqual({ OffMap: { object: 'hide' } });
  expect(await page.evaluate(() => (window as Win).engine.mme.renderer.allWarnings())).toEqual([]);
  expect(errors).toEqual([]);
});

test('ステージの割り当てをプロジェクトに保存し (.wgp)、最初の状態に戻してから開くと、同じ絵', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await stageScene(page);
  const red = await loadFolder(page, 'fx', { 'red.fx': RED_FX }, 'red.fx');
  await page.evaluate(r => (window as Win).engine.mme.assignStage('Main', null, { folder: r.folder, path: r.path }), red);
  await expect.poll(() => rgb(page)).toEqual([255, 0, 0]);

  await page.getByRole('button', { name: 'ファイル' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'プロジェクトを保存' }).click()]);
  const bytes = await readFile((await download.path())!);
  const data = JSON.parse(strFromU8(unzipSync(new Uint8Array(bytes))['project.json']));
  expect(data.mme.stage).toEqual({ Main: { object: { folder: red.folder, path: 'red.fx' } } });

  await page.evaluate(() => (window as Win).engine.resetAll());
  expect(await page.evaluate(() => (window as Win).engine.mme.saveScene().stage ?? null)).toBeNull();
  await page.locator('input[type=file][accept=".wgp,.wgpj"]').setInputFiles({ name: 'stage.wgp', mimeType: 'application/zip', buffer: bytes });
  await expect.poll(async () => (await uiState(page)).toast, { timeout: 30_000 }).toBe('stage.wgp を開きました');
  await expect.poll(() => page.evaluate(() => (window as Win).engine.stage.model !== null)).toBe(true);
  await expect.poll(() => rgb(page)).toEqual([255, 0, 0]);
  expect(await page.evaluate(() => (window as Win).engine.mme.renderer.allWarnings())).toEqual([]);
  expect(errors).toEqual([]);
});
