import { expect, test } from './fixtures/test';
import { open, uiState } from './helpers';

// タイムライン: 再生・フレームの移動・範囲
test.describe('タイムライン', () => {
  test('▶ で再生してフレームが進み、Space で止まる', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: '再生', exact: true }).click();
    await expect.poll(async () => (await uiState(page)).frame).toBeGreaterThan(5);
    await page.locator('canvas#c').hover();
    await page.keyboard.press('Space');
    const { frame, playing } = await uiState(page);
    expect(playing).toBe(false);
    await page.waitForTimeout(300);
    expect((await uiState(page)).frame).toBe(frame);
  });

  test('目盛りを押した位置のフレームへ動く', async ({ page }) => {
    await open(page);
    const box = (await page.locator('#tl-canvas').boundingBox())!;
    // 0〜250 フレームが、両端に 10 フレームずつ余白を付けて並んでいる
    const x = box.x + (100 + 10) / 270 * box.width;
    await page.mouse.click(x, box.y + 10);
    await expect.poll(async () => (await uiState(page)).frame).toBe(100);
    await expect(page.getByRole('spinbutton', { name: 'いまのフレーム' })).toHaveValue('100');
  });

  test('フレームの欄と矢印キーで動かす', async ({ page }) => {
    await open(page);
    await page.getByRole('spinbutton', { name: 'いまのフレーム' }).fill('42');
    await page.keyboard.press('Enter');
    expect((await uiState(page)).frame).toBe(42);
    await page.locator('canvas#c').hover();
    await page.keyboard.press('ArrowRight');
    expect((await uiState(page)).frame).toBe(43);
    await page.keyboard.press('Shift+ArrowRight');
    expect((await uiState(page)).frame).toBe(250);
    await page.keyboard.press('Shift+ArrowLeft');
    expect((await uiState(page)).frame).toBe(0);
  });

  test('終了フレームまで行くと、開始フレームに戻って繰り返す', async ({ page }) => {
    await open(page);
    await page.getByRole('spinbutton', { name: '終了フレーム' }).fill('6');
    await page.keyboard.press('Enter');
    expect((await uiState(page)).end).toBe(6);
    await page.getByRole('button', { name: '再生', exact: true }).click();
    // 0.2 秒 (6 フレーム) を何度か越えても、フレームは 0〜6 の中にある
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(120);
      const f = (await uiState(page)).frame;
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(6);
    }
    expect((await uiState(page)).playing).toBe(true);
  });
});
