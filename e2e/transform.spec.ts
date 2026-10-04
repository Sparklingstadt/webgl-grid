import { expect, test } from './fixtures/test';
import { open, type Win } from './helpers';

// G・R・S (Blender のモーダルな移動・回転・拡大縮小)
const cube = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const o = (window as Win).engine.world.objects[0];
  return { x: +o.x.toFixed(3), z: +o.z.toFixed(3), deg: Math.round(o.r * 180 / Math.PI), scale: o.scale ?? 1 };
});

test('G・R・S: 数字で値を打って Enter、マウスで動かしてクリック、Esc でやめる。Alt で元に戻す。決めるまでで 1 手', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('tree', { name: 'シーンの物' }).getByRole('treeitem', { name: '立方体' }).locator(':scope > .ol-row').click();
  const canvas = page.locator('canvas#c');
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  // G → X → 2 → Enter: X 方向に 2
  await page.keyboard.press('g');
  await expect(page.getByRole('status').filter({ hasText: '移動' })).toBeVisible();
  await page.keyboard.press('x');
  await page.keyboard.type('2');
  await expect(page.getByRole('status').filter({ hasText: 'X 軸' })).toContainText('2');
  await page.keyboard.press('Enter');
  expect(await cube(page)).toMatchObject({ x: 2, z: 0 });
  await expect(page.getByRole('status').filter({ hasText: '移動' })).toHaveCount(0);
  // R → 90 → Enter
  await page.keyboard.press('r');
  await page.keyboard.type('90');
  await page.keyboard.press('Enter');
  expect((await cube(page)).deg).toBe(90);
  // S → 2 → Enter: 大きさ 2 倍 (積み重ねの高さも 2 倍)
  await page.keyboard.press('s');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  expect((await cube(page)).scale).toBe(2);
  await expect(page.locator('#obj-s')).toHaveValue('2.000');
  await expect.poll(() => page.evaluate(() => (window as Win).engine.ui.state.history.labels.slice(-3))).toEqual(['移動', '回転', '大きさ']);
  // マウスで動かしてクリックで決める
  await page.keyboard.press('g');
  await page.mouse.move(cx + 120, cy + 10, { steps: 4 });
  const moving = await cube(page);
  expect(moving.x).not.toBe(2);
  await page.mouse.down();
  await page.mouse.up();
  expect(await cube(page)).toEqual(moving);
  // Esc でやめると元の位置
  await page.keyboard.press('g');
  await page.mouse.move(cx - 150, cy - 60, { steps: 4 });
  await page.keyboard.press('Escape');
  expect(await cube(page)).toEqual(moving);
  // 元に戻すと、マウスで動かす前
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await cube(page)).x).toBe(2);
  // Alt+G・Alt+R・Alt+S で元に戻す
  await page.keyboard.press('Alt+g');
  await page.keyboard.press('Alt+r');
  await page.keyboard.press('Alt+s');
  expect(await cube(page)).toEqual({ x: 0, z: 0, deg: 0, scale: 1 });
  expect(errors).toEqual([]);
});

test('いくつか選んで R すると、真ん中を中心に位置も回る', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const { engine } = window as Win;
    engine.addShape(1);
    const [a, b] = engine.world.objects;
    Object.assign(a, { x: -2, z: 0 }); Object.assign(b, { x: 2, z: 0 });
    engine.world.settle();
    engine.selectAll();
  });
  await page.locator('canvas#c').hover();
  await page.keyboard.press('r');
  await page.keyboard.type('180');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as Win).engine.world.objects.map((o: Win) => Math.round(o.x)))).toEqual([2, -2]);
});

test('G・R・S のあいだ Ctrl を押すと、グリッド・15° にスナップする。見出しの磁石で入れ替わる', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('tree', { name: 'シーンの物' }).getByRole('treeitem', { name: '立方体' }).locator(':scope > .ol-row').click();
  const canvas = page.locator('canvas#c');
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  // G のあと Ctrl を押して動かすと、グリッドの目 (1 m) に乗る
  await page.keyboard.press('g');
  await page.keyboard.down('Control');
  await page.mouse.move(cx + 137, cy + 23, { steps: 4 });
  await expect(page.getByRole('status').filter({ hasText: '移動' })).toContainText('スナップ');
  await page.keyboard.up('Control');
  const free = await cube(page);
  expect(Number.isInteger(free.x) && Number.isInteger(free.z)).toBe(false); // (離すと、スナップしない)
  await page.keyboard.down('Control');
  await page.mouse.move(cx + 139, cy + 24);
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  const snapped = await cube(page);
  expect(Number.isInteger(snapped.x) && Number.isInteger(snapped.z)).toBe(true);
  expect(snapped.x !== 0 || snapped.z !== 0).toBe(true);
  // 磁石を入れると、Ctrl なしでスナップ (回転は 15° ずつ)
  await page.getByRole('button', { name: 'スナップ' }).click();
  await page.mouse.move(cx + 100, cy);
  await page.keyboard.press('r');
  await page.mouse.move(cx + 60, cy + 75, { steps: 4 });
  await page.keyboard.press('Enter');
  const deg = (await cube(page)).deg;
  expect(deg % 15).toBe(0);
  expect(deg).not.toBe(0);
  expect(errors).toEqual([]);
});
