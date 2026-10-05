import { expect, test, type Page } from './fixtures/test';
import { loadTestModel, open, type Win } from './helpers';

// 自動保存: 編集すると少しあとにブラウザの中へ保存され、開き直すと「前回の続き」から開ける
const scene = (page: Page) => page.evaluate(() => (window as Win).engine.world.objects.map((o: Win) => ({
  s: o.s, x: o.x, z: o.z, keys: o.anim ? [...o.anim.bones.keys()] : null, name: o.model?.name ?? null,
})));

test('編集して開き直すと、前回の続き (モデル・キーフレームも) を開ける', async ({ page }) => {
  let errors = await open(page);
  await expect(page.getByRole('region', { name: '前回の続き' })).toHaveCount(0); // 初めてなので出ない
  await loadTestModel(page);
  await page.evaluate(() => {
    const { engine } = window as Win;
    engine.clock.setPlaying(false);
    engine.clock.seekFrame(12);
    engine.insertKey();
    engine.addShape(1);
  });
  await page.locator('canvas#c').hover(); // (キーを離す・マウスを動かすと区切る)
  await page.keyboard.press('Shift');
  const before = await scene(page);
  // 自動保存されるまで待つ
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(ok => { const r = indexedDB.open('webgl-grid-autosave'); r.onsuccess = () => ok(r.result); });
    return new Promise<number>(ok => { const r = db.transaction('sessions').objectStore('sessions').count(); r.onsuccess = () => ok(r.result); });
  }), { timeout: 10_000 }).toBe(1);
  expect(errors).toEqual([]);

  errors = await open(page);
  const banner = page.getByRole('region', { name: '前回の続き' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: '開く' }).click();
  // (モデルの読み込み・物理演算の準備は、遅いマシン (CI) では数秒かかる。そのあいだページが止まるので、
  // 4 秒で消える「前回の続きを開きました」のお知らせは見逃すことがある。戻った場面を待つ)
  await expect.poll(() => scene(page), { timeout: 30_000 }).toEqual(before);
  await expect(banner).toHaveCount(0);
  // ファイル メニューからも開ける
  await page.getByRole('button', { name: 'ファイル' }).click();
  await expect(page.getByRole('menuitem', { name: /前回の続きを開く/ })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('前回の続きの知らせは × で閉じられ、操作のじゃまをしない', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { (window as Win).engine.addShape(2); });
  await expect.poll(() => page.evaluate(() => (window as Win).engine.ui.state.history.labels.length)).toBe(2);
  await page.evaluate(() => (window as Win).engine.autosave.saveNow()); // (待たずに保存する)
  await open(page);
  const banner = page.getByRole('region', { name: '前回の続き' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: '閉じる' }).click();
  await expect(banner).toHaveCount(0);
  expect(await page.evaluate(() => (window as Win).engine.world.objects.length)).toBe(1); // 開いてはいない
});
