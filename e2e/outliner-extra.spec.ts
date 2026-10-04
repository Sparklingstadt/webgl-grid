import { expect, test } from './fixtures/test';
import { makePmx } from './fixtures/pmx';
import { makeVmd } from './fixtures/vmd';
import { open, type Win } from './helpers';

// アウトライナーの、物でないもの: MMD のステージ (隠す・外す) と VMD のカメラモーション (外す)。外しても元に戻せる
test('ステージとカメラモーションもアウトライナーに出し、ステージは隠せて、どちらも右クリックで外せ、元に戻せる', async ({ page }) => {
  const errors = await open(page, { cube: false });
  const tree = page.getByRole('tree', { name: 'シーンの物' });
  // ステージ (名前に「ステージ」とある .pmx)
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'テストステージ.pmx', mimeType: 'application/octet-stream', buffer: Buffer.from(makePmx('テストステージ')) });
  const stage = tree.getByRole('treeitem', { name: 'ステージ: テストステージ' });
  await expect(stage).toBeVisible();
  await stage.getByRole('button', { name: 'ビューポートで隠す' }).click();
  expect(await page.evaluate(() => (window as Win).engine.stage.model.visible)).toBe(false);
  await stage.getByRole('button', { name: 'ビューポートで隠す' }).click();
  expect(await page.evaluate(() => (window as Win).engine.stage.model.visible)).toBe(true);
  // カメラモーション
  const vmd = Buffer.from(makeVmd([], [], [{ frame: 0, distance: -30, target: [0, 10, 0], rot: [0, 0, 0] }, { frame: 30, distance: -40, target: [0, 10, 0], rot: [0, 1, 0] }]));
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'カメラ.vmd', mimeType: 'application/octet-stream', buffer: vmd });
  const cam = tree.getByRole('treeitem', { name: 'カメラモーション: カメラ.vmd' });
  await expect(cam).toBeVisible();
  await expect(page.locator('.view-info')).toHaveText(/カメラ・透視投影/);
  // 右クリックで外す
  await cam.locator(':scope > .ol-row').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'カメラモーションを外す' }).click();
  await expect(cam).toHaveCount(0);
  await expect(page.locator('.view-info')).toHaveText(/ユーザー・透視投影/);
  await stage.locator(':scope > .ol-row').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'ステージを外す' }).click();
  await expect(stage).toHaveCount(0);
  expect(await page.evaluate(() => (window as Win).engine.stage.model)).toBeNull();
  // 元に戻すと、ステージ → カメラモーションの順に戻る。やり直すとまた外れる
  await page.locator('canvas#c').hover();
  await page.keyboard.press('Control+z');
  await expect(stage).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(cam).toBeVisible();
  await expect(page.locator('.view-info')).toHaveText(/カメラ・透視投影/);
  await page.keyboard.press('Control+Shift+z');
  await expect(cam).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await expect(stage).toHaveCount(0);
  expect(errors).toEqual([]);
});
