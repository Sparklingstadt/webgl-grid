import { expect, test } from '@playwright/test';
import { open } from './helpers';

// スマホ (幅の狭い画面) のレイアウト
test.describe('スマホ @mobile', () => {
  test('サイドバーは最初はしまってあり、開くとビューポートに重なり、ビューポートを触るとしまう', async ({ page }) => {
    await open(page);
    await expect(page.locator('#sidebar')).toHaveCount(0);
    await page.getByRole('button', { name: 'サイドバー' }).tap();
    await expect(page.locator('#sidebar')).toBeVisible();
    const canvas = (await page.locator('canvas#c').boundingBox())!;
    await page.touchscreen.tap(canvas.x + 20, canvas.y + canvas.height - 20);
    await expect(page.locator('#sidebar')).toHaveCount(0);
  });

  test('横にはみ出さず、タイムラインの再生ボタンが見える', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '回転' })).toBeVisible();
  });
});
