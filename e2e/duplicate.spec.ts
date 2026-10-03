import { expect, test } from './fixtures/test';
import { makeVmd } from './fixtures/vmd';
import { loadTestModel, open, type Win } from './helpers';

// 複製 (Shift+D): 隣に置いて選び、マテリアルは共有、名前に番号。MMD モデルはポーズ・モーションも写す
const tree = (page: import('@playwright/test').Page) => page.getByRole('tree', { name: 'シーンの物' });

test('Shift+D で形を複製し、アウトライナーの右クリックからも複製できる', async ({ page }) => {
  const errors = await open(page);
  await tree(page).getByRole('treeitem', { name: '立方体', exact: true }).locator(':scope > .ol-row').click();
  await page.locator('canvas#c').hover();
  await page.keyboard.press('Shift+D');
  await expect(tree(page).getByRole('treeitem')).toHaveText(['立方体', '立方体.001']);
  await expect(page.locator('#obj-name')).toHaveValue('立方体.001');
  await tree(page).getByRole('treeitem', { name: '立方体', exact: true }).locator(':scope > .ol-row').click({ button: 'right' });
  await page.getByRole('menu', { name: 'アウトライナーのメニュー' }).getByRole('menuitem', { name: '複製' }).click();
  await expect(tree(page).getByRole('treeitem')).toHaveText(['立方体', '立方体.001', '立方体.002']);
  // マテリアルは共有
  expect(await page.evaluate(() => new Set((window as Win).engine.world.objects.map((o: Win) => o.slots[0])).size)).toBe(1);
  expect(errors).toEqual([]);
});

test('MMD モデルを複製すると、同じファイルから読み直し、モーションとポーズも写す', async ({ page }) => {
  const errors = await open(page, { cube: false });
  const vmd = Buffer.from(makeVmd([{ bone: 'センター', frame: 0, pos: [0, 0, 0] }, { bone: 'センター', frame: 30, pos: [0, 0, 6] }]));
  await loadTestModel(page, [{ name: 'テスト.vmd', mimeType: 'application/octet-stream', buffer: vmd }]);
  await page.evaluate(() => {
    const { engine } = window as Win;
    engine.clock.setPlaying(false);
    engine.setBone(1, 'rz', 25); // 右腕
  });
  await page.getByRole('button', { name: 'オブジェクト', exact: true }).click();
  await page.getByRole('menuitem', { name: '複製' }).click();
  await expect(tree(page).getByRole('treeitem')).toHaveText(['テスト人形', 'テスト人形.001']);
  expect(await page.evaluate(() => {
    const [a, b] = (window as Win).engine.world.models;
    return [b.animated, b.motionFiles.map((f: File) => f.name), b.pose.get(1)?.rz, a.slots.join() === b.slots.join(), a.model !== b.model];
  })).toEqual([true, ['テスト.vmd'], 25, true, true]);
  // 元に戻すと消える
  await page.keyboard.press('Control+z');
  await expect(tree(page).getByRole('treeitem')).toHaveText(['テスト人形']);
  expect(errors).toEqual([]);
});
