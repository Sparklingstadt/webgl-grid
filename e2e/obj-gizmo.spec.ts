import { expect, test } from './fixtures/test';
import { open, type Win } from './helpers';

// ライト・カメラのギズモ: 目印のそばの取っ手を左右にドラッグして、パワー・視野角を変える
async function drag(page: import('@playwright/test').Page, dx: number, opts: { esc?: boolean } = {}) {
  const h = page.locator('.obj-gizmo-handle');
  await h.hover(); // (動き終わるのを待つ)
  const b = (await h.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 5 });
  if (opts.esc) await page.keyboard.press('Escape');
  await page.mouse.up();
}
// 遠くから見る (目印が画面に入るように)
const zoomOut = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const { engine } = window as Win, c = engine.camera.cam;
  c.dist = 40; c.ty = 2;
  engine.viewport.requestDraw();
});
const sel = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const o = (window as Win).engine.selection.current;
  return { power: o.light ? Math.round(o.light.power) : null, fov: o.camera ? Math.round(o.camera.fov) : null };
});

test('ライトの取っ手を右へドラッグするとパワーが上がり、Esc でやめられ、元に戻せる', async ({ page }) => {
  const errors = await open(page, { cube: false });
  await page.evaluate(() => (window as Win).engine.addLight('point'));
  await zoomOut(page);
  expect((await sel(page)).power).toBe(400);
  await drag(page, 100); // (100px で 2 倍)
  await expect.poll(async () => (await sel(page)).power).toBe(800);
  await expect(page.locator('.obj-gizmo-value')).toHaveText('800 W');
  await drag(page, -60, { esc: true });
  expect((await sel(page)).power).toBe(800);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await sel(page)).power).toBe(400);
  // キーボードでも
  await page.locator('.obj-gizmo-handle').focus();
  await page.keyboard.press('ArrowRight');
  expect((await sel(page)).power).toBe(440);
  expect(errors).toEqual([]);
});

test('カメラの取っ手を右へドラッグすると視野角が広がる', async ({ page }) => {
  const errors = await open(page, { cube: false });
  await page.evaluate(() => { const { engine } = window as Win; engine.camera.snapView('front'); engine.addCamera({ fov: 35 }); });
  await zoomOut(page);
  expect((await sel(page)).fov).toBe(35);
  await drag(page, 50); // (1px で 0.2°)
  await expect.poll(async () => (await sel(page)).fov).toBe(45);
  await expect(page.locator('.obj-gizmo-value')).toHaveText('45°');
  expect(errors).toEqual([]);
});
