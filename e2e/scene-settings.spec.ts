import { expect, test, type Page } from './fixtures/test';
import { choose, open, type Win } from './helpers';

// シーン (空・床・太陽): サイドバーの「シーン」から変え、元に戻せ、書き出した画像にも写る
const topPixel = (page: Page) => page.evaluate(async () => {
  const { engine } = window as Win;
  engine.output.set({ width: 64, height: 64 });
  const img = new Image();
  img.src = URL.createObjectURL(await engine.output.renderPng());
  await img.decode();
  const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  return [...g.getImageData(32, 1, 1, 1).data];
});

test('空を単色にすると背景 (書き出した画像も) が変わり、床を置ける。元に戻せる', async ({ page }) => {
  const errors = await open(page);
  expect(await topPixel(page)).toEqual([61, 61, 61, 255]); // ビューポートの灰色
  await page.getByRole('tab', { name: 'シーン' }).click();
  await choose(page, '空の種類', '単色');
  await page.getByRole('button', { name: '色', exact: true }).first().click();
  const hex = page.getByRole('textbox', { name: '色 (16 進)' });
  await hex.fill('#204080');
  await hex.press('Enter');
  expect(await topPixel(page)).toEqual([0x20, 0x40, 0x80, 255]);
  // 床を置く
  await page.getByRole('checkbox', { name: '床を置く' }).click();
  expect(await page.evaluate(() => (window as Win).engine.graph.scene.getObjectByName('floor').visible)).toBe(true);
  // 元に戻す (床 → 空の色 → 空の種類)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await expect.poll(() => page.evaluate(() => (window as Win).engine.ui.state.history.labels.length)).toBeGreaterThan(1);
  for (let i = 0; i < 3; i++) await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => page.evaluate(() => (window as Win).engine.environment.settings.sky.mode)).toBe('viewport');
  expect(await page.evaluate(() => (window as Win).engine.graph.scene.getObjectByName('floor').visible)).toBe(false);
  expect(errors).toEqual([]);
});
