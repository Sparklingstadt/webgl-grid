import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures/test';
import { open, type Win } from './helpers';

// 形・ライトのキーフレーム: I で位置・回転・大きさに打ち、あいだは補間。タイムラインに出て、プロジェクトにも残る
const cubeX = (page: import('@playwright/test').Page) => page.evaluate(() => +(window as Win).engine.world.objects[0].x.toFixed(3));

test('立方体に I でキーを打ち、G で動かしてもう一度打つと、あいだのフレームは補間する。保存して開き直しても動く', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = await open(page);
  await page.getByRole('tree', { name: 'シーンの物' }).getByRole('treeitem', { name: '立方体' }).locator(':scope > .ol-row').click();
  const frame = page.getByRole('spinbutton', { name: 'いまのフレーム' });
  await page.locator('canvas#c').hover();
  await page.keyboard.press('i');
  await frame.fill('30');
  await page.keyboard.press('Enter');
  await page.locator('canvas#c').hover();
  await page.keyboard.press('g');
  await page.keyboard.press('x');
  await page.keyboard.type('3');
  await page.keyboard.press('Enter');
  await page.keyboard.press('i');
  expect(await page.evaluate(() => (window as Win).engine.timelineRows()[0])).toMatchObject({ label: '立方体', keys: [0, 30], editable: true });
  await frame.fill('15');
  await page.keyboard.press('Enter');
  await expect.poll(() => cubeX(page)).toBeCloseTo(1.5, 2);
  // チャンネルの行: 位置 X・位置 Z・回転・大きさ
  await page.getByRole('button', { name: /チャンネル/ }).click();
  expect(await page.evaluate(() => (window as Win).engine.timelineRows().map((r: { label: string }) => r.label))).toEqual(['立方体', '位置 X', '位置 Z', '回転', '大きさ']);
  // 保存して、まっさらなページで開き直す
  await page.getByRole('button', { name: 'ファイル' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'プロジェクトを保存' }).click()]);
  const bytes = await readFile((await download.path())!);
  await open(page, { cube: false });
  await page.locator('input[type=file][accept=".wgp,.wgpj"]').setInputFiles({ name: 'プロジェクト.wgp', mimeType: 'application/zip', buffer: bytes });
  await expect.poll(() => page.evaluate(() => (window as Win).engine.world.objects.length), { timeout: 30_000 }).toBe(1);
  await frame.fill('30');
  await page.keyboard.press('Enter');
  await expect.poll(() => cubeX(page)).toBeCloseTo(3, 2);
  expect(errors).toEqual([]);
});
