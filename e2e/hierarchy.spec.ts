import { expect, test } from './fixtures/test';
import { open, type Win } from './helpers';

// 親子付け (Ctrl+P・Alt+P) とコレクション (M・アウトライナー)
const tree = (page: import('@playwright/test').Page) => page.getByRole('tree', { name: 'シーンの物' });
const item = (page: import('@playwright/test').Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true });

test('Ctrl+P で最後に選んだ物を親にし、子は親について動き、Alt+P で外す。元に戻すと付き直す', async ({ page }) => {
  const errors = await open(page);
  await item(page, '立方体').locator(':scope > .ol-row').click();
  await page.locator('canvas#c').hover();
  await page.keyboard.press('Shift+D'); // 立方体.001 (を選ぶ)
  await expect(item(page, '立方体.001')).toBeVisible();
  // 子 (立方体.001) を選んでから、Shift+クリックで親 (立方体) を足す
  await item(page, '立方体').locator(':scope > .ol-row').click({ modifiers: ['Shift'] });
  await page.locator('canvas#c').hover();
  await page.keyboard.press('Control+p');
  await expect(item(page, '立方体.001')).toHaveAttribute('aria-level', '2');
  const childX = () => page.evaluate(() => (window as Win).engine.world.objects[1].x);
  const x0 = await childX();
  // 親を動かすと、子もついて動く
  await page.evaluate(() => { const { engine } = window as Win; engine.select(engine.world.objects[0]); engine.setObjProp('x', engine.world.objects[0].x + 2); });
  await expect.poll(childX).toBeCloseTo(x0 + 2, 3);
  // プロパティの「関係」にも出る
  await item(page, '立方体.001').locator(':scope > .ol-row').click();
  await expect(page.getByRole('combobox', { name: '親', exact: true })).toHaveText(/立方体/);
  await page.locator('canvas#c').hover();
  await page.keyboard.press('Alt+p');
  await expect(item(page, '立方体.001')).toHaveAttribute('aria-level', '1');
  expect(await page.evaluate(() => (window as Win).engine.world.objects[1].parent)).toBeUndefined();
  await page.keyboard.press('Control+z');
  await expect(item(page, '立方体.001')).toHaveAttribute('aria-level', '2');
  expect(errors).toEqual([]);
});

test('M で新しいコレクションへ移し、アウトライナーでコレクションを隠す・名前を変える・消す', async ({ page }) => {
  const errors = await open(page);
  await item(page, '立方体').locator(':scope > .ol-row').click();
  await page.locator('canvas#c').hover();
  await page.keyboard.press('m');
  await page.getByRole('menu', { name: 'コレクションへ移動' }).getByRole('menuitem', { name: '新しいコレクション' }).click();
  const col = item(page, 'コレクション: コレクション');
  await expect(col).toBeVisible();
  await expect(item(page, '立方体')).toHaveAttribute('aria-level', '2');
  // 隠すと、ビューポートに出ず、A でも選ばない
  await col.getByRole('button', { name: 'コレクションを隠す' }).click();
  expect(await page.evaluate(() => (window as Win).engine.world.objects[0].node.visible)).toBe(false);
  await page.locator('canvas#c').hover();
  await page.keyboard.press('a');
  expect(await page.evaluate(() => (window as Win).engine.selection.list.length)).toBe(0);
  await col.getByRole('button', { name: 'コレクションを隠す' }).click();
  expect(await page.evaluate(() => (window as Win).engine.world.objects[0].node.visible)).toBe(true);
  // ダブルクリックで名前を変える
  await col.locator(':scope > .ol-row .ol-name').dblclick();
  await tree(page).getByRole('textbox', { name: '名前' }).fill('背景');
  await page.keyboard.press('Enter');
  await expect(item(page, 'コレクション: 背景')).toBeVisible();
  expect(await page.evaluate(() => (window as Win).engine.world.objects[0].collection)).toBe('背景');
  // 右クリックで消す (中の物はシーン コレクションへ)
  await item(page, 'コレクション: 背景').locator(':scope > .ol-row').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'コレクションを消す (中の物は残す)' }).click();
  await expect(item(page, 'コレクション: 背景')).toHaveCount(0);
  await expect(item(page, '立方体')).toHaveAttribute('aria-level', '1');
  expect(errors).toEqual([]);
});
