import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures/test';
import { open, type Win } from './helpers';

// カメラの物 (Blender のカメラ): いまの視点に置き、テンキー 0 でそこから見る。カメラのタブ。プロジェクトにも残る
test('追加 > カメラで置き、カメラのタブで変え、テンキー 0 でそこから見る。自分で動かすと戻る。保存して開き直しても残る', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = await open(page);
  await page.getByRole('button', { name: '追加' }).click();
  await page.getByRole('menuitem', { name: 'カメラ', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'シーンの物' }).getByRole('treeitem', { name: 'カメラ' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'カメラ' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('このカメラが場面のカメラです')).toBeVisible();
  await page.getByRole('slider', { name: '視野角' }).focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  const fov = await page.evaluate(() => (window as Win).engine.selection.current.camera.fov);
  // テンキー 0 で、カメラから見る
  const canvas = page.locator('canvas#c');
  await canvas.hover();
  await page.keyboard.press('Numpad0');
  await expect(page.locator('.view-info')).toHaveText(/カメラ・透視投影/);
  expect(await page.evaluate(() => (window as Win).engine.camera.camera.fov)).toBeCloseTo(fov, 5);
  // 自分で動かすと、ふつうの視点に戻る
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + box.height - 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height - 60, { steps: 3 });
  await page.mouse.up();
  await expect(page.locator('.view-info')).toHaveText(/ユーザー・透視投影/);
  // 保存して開き直す
  await page.getByRole('button', { name: 'ファイル' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'プロジェクトを保存' }).click()]);
  const bytes = await readFile((await download.path())!);
  await open(page, { cube: false });
  await page.locator('input[type=file][accept=".wgp,.wgpj"]').setInputFiles({ name: 'プロジェクト.wgp', mimeType: 'application/zip', buffer: bytes });
  await expect.poll(() => page.evaluate(() => (window as Win).engine.world.objects.map((o: Win) => o.camera?.fov ?? null)), { timeout: 30_000 }).toEqual([null, fov]);
  expect(errors).toEqual([]);
});
