import { expect, test } from './fixtures/test';
import { open, screenPosOf, type Win } from './helpers';

// 複数選択 (Blender と同じ): Shift+クリック・A / Alt+A / Ctrl+I・ボックス選択 (B)・アウトライナーの Ctrl+クリック
const selected = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const { engine } = window as Win;
  return { ids: engine.ui.state.selIds as number[], active: engine.selection.current?.id ?? null };
});

test('Shift+クリックで足し、A ですべて、Alt+A で解除、Ctrl+I で反転。X で全部消す', async ({ page }) => {
  const errors = await open(page);
  for (const shape of ['トーラス', '三角錐']) {
    await page.getByRole('button', { name: '追加' }).click();
    await page.getByRole('menuitem', { name: shape }).click();
  }
  const ids = await page.evaluate(() => (window as Win).engine.world.objects.map((o: Win) => o.id));
  const p0 = await screenPosOf(page, 0), p1 = await screenPosOf(page, 1);
  await page.mouse.click(p0.x, p0.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(p1.x, p1.y);
  await page.keyboard.up('Shift');
  expect(await selected(page)).toEqual({ ids: [ids[0], ids[1]], active: ids[1] });
  await expect(page.getByRole('contentinfo', { name: '状態バー' })).toContainText('オブジェクト 2/3');
  // アウトライナーでも、選んでいる行は選ばれている
  await expect(page.getByRole('tree', { name: 'シーンの物' }).getByRole('treeitem', { selected: true })).toHaveCount(2);
  await page.keyboard.press('Control+i');
  expect(await selected(page)).toEqual({ ids: [ids[2]], active: ids[2] });
  await page.keyboard.press('a');
  expect((await selected(page)).ids).toEqual(ids);
  await page.keyboard.press('Alt+a');
  expect((await selected(page)).ids).toEqual([]);
  // アウトライナーの Ctrl+クリックで足して、X で両方消す
  const tree = page.getByRole('tree', { name: 'シーンの物' });
  await tree.getByRole('treeitem', { name: '立方体' }).locator(':scope > .ol-row').click();
  await tree.getByRole('treeitem', { name: '三角錐' }).locator(':scope > .ol-row').click({ modifiers: ['ControlOrMeta'] });
  expect((await selected(page)).ids).toEqual([ids[0], ids[2]]);
  await page.locator('canvas#c').hover();
  await page.keyboard.press('x');
  await expect(tree.getByRole('treeitem')).toHaveText(['トーラス']);
  expect(errors).toEqual([]);
});

test('B のあと、ドラッグで囲んだ物を選ぶ (Esc でやめる)', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '追加' }).click();
  await page.getByRole('menuitem', { name: 'トーラス' }).click();
  const p0 = await screenPosOf(page, 0), p1 = await screenPosOf(page, 1);
  await page.locator('canvas#c').hover();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+a');
  // Esc でやめると、ドラッグはカメラの操作
  await page.keyboard.press('b');
  await expect(page.locator('.view-mode-hint')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.view-mode-hint')).toHaveCount(0);
  // 2 つを囲む
  await page.keyboard.press('b');
  const [x0, x1] = [Math.min(p0.x, p1.x) - 40, Math.max(p0.x, p1.x) + 40], [y0, y1] = [Math.min(p0.y, p1.y) - 40, Math.max(p0.y, p1.y) + 40];
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 3 });
  await expect(page.locator('.select-box')).toBeVisible();
  await page.mouse.move(x1, y1, { steps: 3 });
  await page.mouse.up();
  await expect(page.locator('.select-box')).toHaveCount(0);
  expect((await selected(page)).ids.length).toBe(2);
});

test('ビューポートの右クリック: 押した物を選んでメニューを出し、複製・削除などができる。右ドラッグはカメラのまま', async ({ page }) => {
  await open(page);
  const p = await screenPosOf(page, 0);
  const menu = page.getByRole('menu', { name: 'オブジェクトのメニュー' });
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('立方体');
  expect((await selected(page)).ids.length).toBe(1);
  await menu.getByRole('menuitem', { name: '複製' }).click();
  await expect(menu).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as Win).engine.world.objects.length)).toBe(2);
  // 何もない所: 選択の操作だけ使える
  const box = (await page.locator('canvas#c').boundingBox())!;
  await page.keyboard.press('Alt+a');
  await page.mouse.click(box.x + 30, box.y + box.height - 30, { button: 'right' });
  await expect(menu.getByRole('menuitem', { name: '削除' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // 右ドラッグはカメラを回すだけで、メニューは出さない
  const yaw = () => page.evaluate(() => (window as Win).engine.camera.cam.yaw);
  const before = await yaw();
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + 180, box.y + 110, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  expect(await yaw()).not.toBe(before);
  await expect(menu).toHaveCount(0);
});
