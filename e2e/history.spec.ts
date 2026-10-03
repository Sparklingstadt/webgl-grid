import { expect, test, type Page } from './fixtures/test';
import { makeVmd } from './fixtures/vmd';
import { loadTestModel, open, screenPosOf, type Win } from './helpers';

// 元に戻す・やり直し (Ctrl+Z / Ctrl+Shift+Z)
const history = (page: Page) => page.evaluate(() => (window as Win).engine.ui.state.history);
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test('物をドラッグで運ぶと 1 手になり、Ctrl+Z で戻り Ctrl+Shift+Z でやり直す', async ({ page }) => {
  const errors = await open(page);
  const p = await screenPosOf(page, 0);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 120, p.y + 40, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await history(page)).labels).toEqual(['最初', '移動']);
  const moved = await page.evaluate(() => { const o = (window as Win).engine.world.objects[0]; return [o.x, o.z]; });
  expect(moved).not.toEqual([0, 0]);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => page.evaluate(() => { const o = (window as Win).engine.world.objects[0]; return [o.x, o.z]; })).toEqual([0, 0]);
  await expect(page.getByRole('status')).toHaveText('元に戻す: 移動');
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect.poll(() => page.evaluate(() => { const o = (window as Win).engine.world.objects[0]; return [o.x, o.z]; })).toEqual(moved);
  // 編集メニューに、元に戻す手の名前と履歴が出る
  await page.getByRole('button', { name: '編集' }).click();
  await expect(page.getByRole('menuitem', { name: '元に戻す: 移動' })).toBeEnabled();
  await expect(page.getByRole('menuitem', { name: /やり直す/ })).toBeDisabled();
  await page.getByRole('menuitem', { name: '最初' }).click(); // 履歴から最初の状態へ
  await expect.poll(() => page.evaluate(() => (window as Win).engine.world.objects[0].x)).toBe(0);
  expect(errors).toEqual([]);
});

test('MMD モデル: キーフレームと削除を戻すと、物理演算とモーションも付いたまま戻る', async ({ page }) => {
  const errors = await open(page);
  const vmd = makeVmd([{ bone: 'センター', frame: 0, pos: [0, 0, 0] }, { bone: 'センター', frame: 30, pos: [0, 0, 3] }]);
  await loadTestModel(page, [{ name: 'テスト.vmd', mimeType: 'application/octet-stream', buffer: Buffer.from(vmd) }], { physics: true });
  await expect.poll(() => page.evaluate(() => (window as Win).engine.physics.entries.length), { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await history(page)).labels).toEqual(['最初', '追加']);
  await page.evaluate(() => { const { engine } = window as Win; engine.clock.setPlaying(false); engine.clock.seekFrame(0); });
  await page.locator('canvas#c').hover();
  await page.keyboard.press('i'); // キーフレーム
  await expect.poll(async () => (await history(page)).labels.at(-1)).toBe('キーフレーム');
  await page.keyboard.press('x'); // 選んでいるモデルを消す
  await expect.poll(async () => (await history(page)).labels.at(-1)).toBe('削除');
  expect(await page.evaluate(() => (window as Win).engine.world.models.length)).toBe(0);

  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => page.evaluate(() => {
    const { engine } = window as Win, m = engine.world.models[0];
    return m && { keys: [...m.keys.keys()], animated: !!m.animated, physics: engine.physics.entries.length };
  }), { timeout: 30_000 }).toEqual({ keys: [0], animated: true, physics: 1 });
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => page.evaluate(() => (window as Win).engine.world.models[0].keys?.size ?? 0)).toBe(0);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect.poll(() => page.evaluate(() => (window as Win).engine.world.models[0].keys?.size ?? 0)).toBe(1);
  // 最初まで戻すとモデルは消え、やり直すと読み直さずに戻る
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => page.evaluate(() => (window as Win).engine.world.models.length)).toBe(0);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect.poll(() => page.evaluate(() => (window as Win).engine.world.models.length)).toBe(1);
  expect(errors).toEqual([]);
});
