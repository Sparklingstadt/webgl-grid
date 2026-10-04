import { expect, test, type Page } from './fixtures/test';
import { open, type Win } from './helpers';

// タイムラインのマーカー (M) と曲の波形
const markers = (page: Page) => page.evaluate(() => (window as Win).engine.markers.list.map((m: Win) => [m.frame, m.name]));
const xOf = (page: Page, f: number, w: number) => page.evaluate(([f, w]) => {
  const { engine } = window as Win, s = engine.clock.start, e = engine.clock.end;
  const f0 = s - (e - s) * 0.04, f1 = e + (e - s) * 0.04;
  return (f - f0) / (f1 - f0) * w;
}, [f, w]);

test('タイムラインの上で M でマーカーを置き、ドラッグで動かし、ダブルクリックで名前を変え、X で消す。元に戻せる', async ({ page }) => {
  const errors = await open(page);
  const canvas = page.locator('#tl-canvas');
  await page.evaluate(() => (window as Win).engine.clock.seekFrame(30));
  await canvas.hover();
  await page.keyboard.press('m');
  expect(await markers(page)).toEqual([[30, 'F_30']]);
  expect(await page.evaluate(() => (window as Win).engine.ui.state.collectionMenu)).toBeNull(); // (コレクションのメニューは出さない)
  // 下の帯のマーカーを、フレーム 50 までドラッグ
  const box = (await canvas.boundingBox())!;
  const y = box.y + box.height - 10;
  await page.mouse.move(box.x + await xOf(page, 30, box.width), y);
  await page.mouse.down();
  await page.mouse.move(box.x + await xOf(page, 50, box.width), y, { steps: 5 });
  await page.mouse.up();
  expect(await markers(page)).toEqual([[50, 'F_30']]);
  // ダブルクリックで名前を変える
  await page.mouse.dblclick(box.x + await xOf(page, 50, box.width), y);
  await page.getByRole('textbox', { name: 'マーカーの名前' }).fill('サビ');
  await page.keyboard.press('Enter');
  expect(await markers(page)).toEqual([[50, 'サビ']]);
  // 元に戻す (名前 → 位置)
  await page.keyboard.press('Control+z');
  await expect.poll(() => markers(page)).toEqual([[50, 'F_30']]);
  await page.keyboard.press('Control+z');
  await expect.poll(() => markers(page)).toEqual([[30, 'F_30']]);
  // 選んで X (キーを選んでいなければマーカーを消す)
  await page.mouse.click(box.x + await xOf(page, 30, box.width), y);
  await canvas.hover();
  await page.keyboard.press('x');
  expect(await markers(page)).toEqual([]);
  expect(await page.evaluate(() => (window as Win).engine.world.objects.length)).toBe(1); // (物は消さない)
  expect(errors).toEqual([]);
});

test('曲を読み込むと、フレームごとの音の大きさ (波形) を求める', async ({ page }) => {
  const errors = await open(page, { cube: false });
  // 前の 1 秒は音 (振れ幅 0.5)、後ろの 1 秒は無音 (16 bit・モノラル・8 kHz)
  const rate = 8000, n = rate * 2, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < rate; i++) b.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 220) * 16384), 44 + i * 2);
  await page.locator('input[type=file][multiple]').setInputFiles({ name: '曲.wav', mimeType: 'audio/wav', buffer: b });
  await expect.poll(() => page.evaluate(() => (window as Win).engine.music.waveform?.length ?? 0)).toBeGreaterThanOrEqual(59);
  const [loud, quiet] = await page.evaluate(() => { const w = (window as Win).engine.music.waveform; return [w[10], w[45]]; });
  expect(loud).toBeGreaterThan(0.4);
  expect(quiet).toBeLessThan(0.01);
  expect(errors).toEqual([]);
});
