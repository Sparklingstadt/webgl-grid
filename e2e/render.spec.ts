import { readFile } from 'node:fs/promises';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { expect, test } from './fixtures/test';
import { makeVmd } from './fixtures/vmd';
import { loadTestModel, open, type Win } from './helpers';

// レンダリング (Blender の F12 / Ctrl+F12): 出力の大きさで画像・動画を書き出す
test('F12 で画像をレンダリングし、レンダー結果から PNG を保存する', async ({ page }) => {
  const errors = await open(page);
  // 出力タブで大きさを決める
  await page.getByRole('tab', { name: '出力' }).click();
  await page.getByRole('spinbutton', { name: '解像度 X' }).fill('321'); // 偶数にそろう
  await page.keyboard.press('Enter');
  await page.getByRole('spinbutton', { name: '解像度 Y' }).fill('200');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: '解像度のプリセット' })).toHaveText('カスタム');
  // 立方体を選んだまま描いても、選択の輪郭線とグリッドは描かない (背景はビューポートの灰色で塗る)
  await page.evaluate(() => { const { engine } = window as Win; engine.select(engine.world.objects[0]); });
  await page.locator('canvas#c').hover();
  await page.keyboard.press('F12');
  const dialog = page.getByRole('dialog', { name: 'レンダー結果' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('322 × 200');
  // 画像の中身: 大きさと、上の角が背景色で塗られていること・選択の色 (オレンジ) がないこと
  const px = await page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>('.render-result img')!;
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight });
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let orange = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 120 && d[i + 1] < 190 && d[i + 2] < 80) orange++;
    return { w: c.width, h: c.height, corner: [...d.slice(0, 4)], orange };
  });
  expect(px).toEqual({ w: 322, h: 200, corner: [0x3d, 0x3d, 0x3d, 255], orange: 0 });
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: /画像を保存/ }).click()]);
  expect(download.suggestedFilename()).toBe('レンダー_0000.png');
  const png = await readFile((await download.path())!);
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([322, 200]); // IHDR の幅と高さ
  // Esc で閉じると、ビューポートは元の大きさに戻っている
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const canvas = await page.evaluate(() => { const c = (window as Win).engine.viewport.canvas; return [c.width, c.height, c.clientWidth]; });
  expect(canvas[0]).toBeGreaterThan(322);
  expect(errors).toEqual([]);
});

test('レンダー > アニメーションをレンダリング で、開始〜終了フレームを動画にする', async ({ page }) => {
  const errors = await open(page);
  const vmd = makeVmd([{ bone: 'センター', frame: 0, pos: [0, 0, 0] }, { bone: 'センター', frame: 30, pos: [0, 0, 5] }]);
  await loadTestModel(page, [{ name: 'テスト.vmd', mimeType: 'application/octet-stream', buffer: Buffer.from(vmd) }]);
  // 小さな大きさで 0〜14 フレーム (15 フレーム)。形式はこのブラウザで作れるもの
  const format = await page.evaluate(async () => {
    const { engine } = window as Win;
    engine.clock.setPlaying(false);
    engine.clock.setRange(0, 14);
    engine.clock.seekFrame(7);
    const ok = await VideoEncoder.isConfigSupported({ codec: 'avc1.42001f', width: 320, height: 240 }).then(r => !!r.supported, () => false);
    engine.setOutput({ width: 320, height: 240, format: ok ? 'mp4' : 'webm' });
    return ok ? 'mp4' : 'webm';
  });
  await page.getByRole('button', { name: 'レンダー' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('menuitem', { name: 'アニメーションをレンダリング' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`テスト人形.${format}`);
  const input = new Input({ source: new BufferSource(await readFile((await download.path())!)), formats: ALL_FORMATS });
  const track = (await input.getPrimaryVideoTrack())!;
  expect([track.displayWidth, track.displayHeight]).toEqual([320, 240]);
  expect((await track.computePacketStats()).packetCount).toBe(15);
  // 終わったら、もとのフレーム・止まった状態に戻る
  expect(await page.evaluate(() => { const { engine } = window as Win; return [engine.clock.frame, engine.clock.playing, engine.ui.state.rendering]; })).toEqual([7, false, null]);
  await expect(page.getByRole('status')).toContainText('15 フレーム');
  expect(errors).toEqual([]);
});
