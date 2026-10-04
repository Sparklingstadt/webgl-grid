import { expect, test, type Page } from './fixtures/test';
import { choose, open, type Win } from './helpers';

// 出力のプリセット・レンダー範囲 (Ctrl+B)・モーションブラー
const png = (page: Page) => page.evaluate(async () => {
  const { engine } = window as Win;
  const img = new Image();
  img.src = URL.createObjectURL(await engine.output.renderPng());
  await img.decode();
  const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] * 3 + d[i + 2] * 7;
  return { w: img.width, h: img.height, sum, frame: engine.clock.frame };
});

test('出力のプリセットで大きさ・形式・画質をまとめて変え、いまの設定を自分のプリセットに保存して消せる', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('tab', { name: '出力' }).click();
  await choose(page, '出力のプリセット', 'ショート動画 (1080×1920・MP4・高)');
  expect(await page.evaluate(() => { const s = (window as Win).engine.output.settings; return [s.width, s.height, s.format, s.quality]; })).toEqual([1080, 1920, 'mp4', 'high']);
  await page.evaluate(() => (window as Win).engine.output.set({ width: 640, height: 480, format: 'webm', quality: 'medium' }));
  await page.getByRole('button', { name: 'いまの設定を保存' }).click();
  await expect(page.getByRole('combobox', { name: '出力のプリセット' })).toHaveText(/640×480・WEBM・標準/);
  await page.evaluate(() => (window as Win).engine.output.set({ width: 1920, height: 1080 }));
  await choose(page, '出力のプリセット', '640×480・WEBM・標準');
  expect(await page.evaluate(() => (window as Win).engine.output.settings.width)).toBe(640);
  await page.reload(); // (ブラウザに覚えている)
  await page.getByRole('tab', { name: '出力' }).click();
  await page.evaluate(() => (window as Win).engine.output.set({ width: 640, height: 480, format: 'webm', quality: 'medium' }));
  await page.getByRole('button', { name: 'このプリセットを消す' }).click();
  await expect(page.getByRole('combobox', { name: '出力のプリセット' })).toHaveText('カスタム');
  expect(errors).toEqual([]);
});

test('Ctrl+B で出力の枠の中を囲むと、その部分だけを書き出し、Ctrl+Alt+B で消す', async ({ page }) => {
  const errors = await open(page);
  await page.evaluate(() => (window as Win).engine.output.set({ width: 400, height: 200 }));
  const frame = page.locator('.output-frame');
  const f = (await frame.boundingBox())!;
  await page.locator('canvas#c').hover();
  await page.keyboard.press('Control+b');
  await expect(page.getByText('レンダー範囲: 出力の枠の中をドラッグで囲む')).toBeVisible();
  // 枠の左上 1/4 を囲む (枠の外 (ビューポートの中) から始めても、枠の中に収める)
  const v = (await page.locator('.viewport').boundingBox())!;
  await page.mouse.move(Math.max(f.x - 20, v.x + 2), Math.max(f.y - 20, v.y + 2));
  await page.mouse.down();
  await page.mouse.move(f.x + f.width / 2, f.y + f.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('.render-region')).toBeVisible();
  const r = await png(page);
  expect([r.w, r.h]).toEqual([200, 100]);
  await page.keyboard.press('Control+Alt+b');
  await expect(page.locator('.render-region')).toHaveCount(0);
  expect(await png(page)).toMatchObject({ w: 400, h: 200 });
  expect(errors).toEqual([]);
});

test('モーションブラーをオンにすると、動いている物がぼけて描かれ、いまのフレームは変わらない', async ({ page }) => {
  const errors = await open(page);
  // 立方体が 1 フレームで横に大きく動く
  await page.evaluate(() => {
    const { engine } = window as Win, o = engine.world.objects[0];
    engine.output.set({ width: 160, height: 90 });
    engine.select(o);
    engine.clock.seekFrame(0); engine.insertKey();
    engine.clock.seekFrame(2); engine.setObjProp('x', 3); engine.insertKey();
    engine.clock.seekFrame(2);
    engine.select(null);
  });
  const sharp = await png(page);
  await page.getByRole('tab', { name: '出力' }).click();
  await page.getByRole('checkbox', { name: 'モーションブラーを使う' }).click();
  await page.evaluate(() => (window as Win).engine.output.set({ shutter: 1, blurSamples: 6 }));
  const blurred = await png(page);
  expect(blurred.frame).toBe(2);
  expect(blurred.sum).not.toBe(sharp.sum);
  // 止まっている所 (キーのない場面) では、ぼけない
  await page.evaluate(() => { const { engine } = window as Win; engine.clock.seekFrame(40); });
  const still = await png(page);
  await page.evaluate(() => (window as Win).engine.output.set({ motionBlur: false }));
  expect(Math.abs((await png(page)).sum - still.sum) / still.sum).toBeLessThan(0.002);
  expect(errors).toEqual([]);
});
