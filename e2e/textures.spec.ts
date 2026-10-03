import { expect, test } from './fixtures/test';
import { makePmx } from './fixtures/pmx';
import { open, type Win } from './helpers';

// 1 × 1 の赤い PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const pmx = (name: string) => ({ name: `${name}.pmx`, mimeType: 'application/octet-stream', buffer: Buffer.from(makePmx(name, { texture: 'tex\\body.png' })) });
const imageNodes = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const { engine } = window as Win;
  const m = engine.world.models[0];
  return engine.library.materials.get(m.slots[0]).tree.nodes.filter((n: Win) => n.type === 'image').length;
});

test('.pmx だけを選ぶとテクスチャを探す窓が出て、画像を選ぶとテクスチャ付きで置く', async ({ page }) => {
  const errors = await open(page);
  await page.locator('input[type=file][multiple]').first().setInputFiles([pmx('テクスチャ人形')]);
  const dialog = page.getByRole('dialog', { name: 'テクスチャを探す' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('list', { name: '見つからないテクスチャ' })).toContainText('tex/body.png');
  await dialog.getByLabel('テクスチャの画像を選ぶ').setInputFiles([{ name: 'body.png', mimeType: 'image/png', buffer: PNG }]);
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as Win).engine.world.models.length)).toBe(1);
  expect(await imageNodes(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('テクスチャなしで置く (Esc) と、材質の色で置いて、見つからない数を知らせる。画面に落としても読み込める', async ({ page }) => {
  const errors = await open(page);
  // 画面にファイルを落とす
  await page.evaluate(async (bytes: number[]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], '落とした人形.pmx'));
    document.querySelector('#c')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [...pmx('落とした人形').buffer]);
  await expect(page.getByRole('dialog', { name: 'テクスチャを探す' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => (window as Win).engine.world.models.length)).toBe(1);
  expect(await imageNodes(page)).toBe(0);
  await expect(page.getByText(/見つからないテクスチャが 1 個あります/)).toBeVisible();
  expect(errors).toEqual([]);
});
