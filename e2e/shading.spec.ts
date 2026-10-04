import { expect, test, type Page } from './fixtures/test';
import { open, type Win } from './helpers';

// ビューポートの表示 (Z): ワイヤーフレーム・ソリッド・マテリアル・レンダー。レンダリング (F12) はいつもレンダーで描く
const centerPixel = (page: Page) => page.evaluate(async () => {
  const { engine } = window as Win;
  engine.output.set({ width: 64, height: 64 });
  const img = new Image();
  img.src = URL.createObjectURL(await engine.output.renderPng());
  await img.decode();
  const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  return [...g.getImageData(32, 36, 1, 1).data];
});
const material = (page: Page) => page.evaluate(() => (window as Win).engine.world.objects[0].mesh.material.type);

test('Z のメニューと見出しのボタンで表示を変え、Shift+Z でワイヤーフレームと行き来する。描いたあとは元の材質に戻り、書き出しには効かない', async ({ page }) => {
  const errors = await open(page);
  const rendered = await centerPixel(page);
  const before = await material(page);
  // Z → 2: ソリッド
  await page.locator('canvas#c').hover();
  await page.keyboard.press('z');
  await expect(page.getByRole('menu', { name: 'ビューポートの表示' })).toBeVisible();
  await page.keyboard.press('2');
  await expect(page.getByRole('menu', { name: 'ビューポートの表示' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ソリッド' })).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => (window as Win).engine.viewport.render());
  expect(await material(page)).toBe(before); // (描くあいだだけ差し替える)
  expect(await centerPixel(page)).toEqual(rendered); // (書き出しはレンダーのまま)
  // Shift+Z: ワイヤーフレームとソリッドを行き来する
  await page.keyboard.press('Shift+z');
  await expect(page.getByRole('button', { name: 'ワイヤーフレーム' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Shift+z');
  await expect(page.getByRole('button', { name: 'ソリッド' })).toHaveAttribute('aria-pressed', 'true');
  // 見出しのボタン。開き直しても覚えている
  await page.getByRole('button', { name: 'マテリアルプレビュー' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'マテリアルプレビュー' })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});
