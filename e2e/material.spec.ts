import { expect, test } from './fixtures/test';
import { loadTestModel, open, type Win } from './helpers';

// マテリアル: モデルの材質の一覧と、色・不透明度・表示・輪郭線を変え、元に戻す
const body = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const m = (window as Win).engine.selection.current.model.material[0];
  return { opacity: m.opacity, transparent: m.transparent, visible: m.visible, diffuse: `#${m.diffuse.getHexString()}`,
           edge: m.userData.baseOutline?.visible ?? m.userData.outlineParameters.visible };
});

test('材質を選んで、色・不透明度・表示・輪郭線を変え、元に戻す', async ({ page }) => {
  const errors = await open(page);
  await loadTestModel(page);
  await page.getByRole('tab', { name: 'マテリアル' }).click();
  await expect(page.getByRole('listbox', { name: '材質' }).getByRole('option')).toHaveText(['体']);
  const original = await body(page);
  expect(original).toMatchObject({ opacity: 1, transparent: false, visible: true, edge: true });

  await page.getByRole('textbox', { name: '色' }).first().fill('#336699');
  await page.getByRole('slider', { name: '不透明度' }).focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await page.getByRole('checkbox', { name: '輪郭線を付ける' }).uncheck();
  expect(await body(page)).toMatchObject({ diffuse: '#336699', opacity: 0.9, transparent: true, edge: false });
  // 変えた材質には印が付く
  await expect(page.getByRole('option').locator('.mat-edited')).toHaveCount(1);

  // 一覧の目のボタンで隠す
  await page.getByRole('button', { name: '体を隠す' }).click();
  expect((await body(page)).visible).toBe(false);
  await expect(page.getByRole('button', { name: '体を表示する' })).toBeVisible();

  await page.getByRole('button', { name: 'すべて元に戻す' }).click();
  expect(await body(page)).toEqual(original);
  await expect(page.getByRole('option').locator('.mat-edited')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('モデルを選んでいなければ、マテリアルのページは案内だけ', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: 'マテリアル' }).click();
  await expect(page.getByText('MMD モデルをクリックして選ぶと')).toBeVisible();
});
