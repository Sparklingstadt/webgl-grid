import { expect, test, type Page } from './fixtures/test';
import { open, type Win } from './helpers';

// タイムラインのキー: 行の何もない所をドラッグして囲んで選ぶ、Ctrl+C・Ctrl+V でいまのフレームへ写す、右クリックのメニュー
async function keyed(page: Page) {
  await page.evaluate(() => {
    const { engine } = window as Win;
    const o = engine.world.objects[0];
    engine.select(o);
    for (const [f, x] of [[0, 0], [20, 1], [40, 2]]) { engine.clock.seekFrame(f); engine.setObjProp('x', x); engine.insertKey(); }
    engine.clock.seekFrame(0);
    engine.selectKeys([], false);
  });
}
// フレーム f の、タイムラインのキャンバスの中の x (見えている範囲は開始〜終了に合わせてある)
const xOf = (page: Page, f: number, w: number) => page.evaluate(([f, w]) => {
  const { engine } = window as Win, s = engine.clock.start, e = engine.clock.end;
  const f0 = s - (e - s) * 0.04, f1 = e + (e - s) * 0.04;
  return (f - f0) / (f1 - f0) * w;
}, [f, w]);
const frames = (page: Page) => page.evaluate(() => (window as Win).engine.timelineRows()[0].keys);
const selected = (page: Page) => page.evaluate(() => [...(window as Win).engine.keyframes.selected].sort((a: number, b: number) => a - b));

test('行をドラッグして囲んだキーを選び、Ctrl+C・Ctrl+V でいまのフレームへ写す。元に戻せる', async ({ page }) => {
  const errors = await open(page);
  await keyed(page);
  const canvas = page.locator('#tl-canvas');
  const box = (await canvas.boundingBox())!;
  const rowY = box.y + 30 + 11;
  // フレーム 15〜45 を囲む (20 と 40)
  await page.mouse.move(box.x + await xOf(page, 15, box.width), rowY - 8);
  await page.mouse.down();
  await page.mouse.move(box.x + await xOf(page, 45, box.width), rowY + 8, { steps: 5 });
  await page.mouse.up();
  expect(await selected(page)).toEqual([20, 40]);
  expect(await page.evaluate(() => (window as Win).engine.clock.frame)).toBe(0); // (囲んだときは動かない)
  // Shift で足す
  await page.mouse.move(box.x + await xOf(page, -5, box.width), rowY - 8);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(box.x + await xOf(page, 5, box.width), rowY + 8, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  expect(await selected(page)).toEqual([0, 20, 40]);
  // 20 と 40 だけ選び直して、フレーム 100 へ写す
  await page.evaluate(() => (window as Win).engine.selectKeys([20, 40], false));
  await page.keyboard.press('Control+c');
  await page.evaluate(() => (window as Win).engine.clock.seekFrame(100));
  await page.keyboard.press('Control+v');
  expect(await frames(page)).toEqual([0, 20, 40, 100, 120]);
  expect(await selected(page)).toEqual([100, 120]);
  expect(await page.evaluate(() => (window as Win).engine.world.objects[0].anim.props.get(0).get(120).v)).toBe(2);
  await page.keyboard.press('Control+z');
  await expect.poll(() => frames(page)).toEqual([0, 20, 40]);
  // 押して離すだけなら、そのフレームへ動いて選択を外す
  await page.mouse.click(box.x + await xOf(page, 60, box.width), rowY);
  await expect.poll(() => page.evaluate(() => (window as Win).engine.clock.frame)).toBe(60);
  expect(await selected(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('タイムラインの右クリックのメニューと、タイムラインの上の A でキーを選ぶ', async ({ page }) => {
  const errors = await open(page);
  await keyed(page);
  const canvas = page.locator('#tl-canvas');
  await canvas.hover();
  await page.keyboard.press('a');
  expect(await selected(page)).toEqual([0, 20, 40]);
  expect(await page.evaluate(() => (window as Win).engine.selection.list.length)).toBe(1); // (物の選択はそのまま)
  await page.keyboard.press('Alt+a');
  expect(await selected(page)).toEqual([]);
  await canvas.click({ button: 'right', position: { x: 300, y: 50 } });
  const menu = page.getByRole('menu', { name: 'キーのメニュー' });
  await menu.getByRole('menuitem', { name: 'すべてのキーを選択' }).click();
  expect(await selected(page)).toEqual([0, 20, 40]);
  await canvas.click({ button: 'right', position: { x: 300, y: 50 } });
  await menu.getByRole('menuitem', { name: 'キーを削除' }).click();
  expect(await frames(page)).toEqual([]);
  expect(errors).toEqual([]);
});
