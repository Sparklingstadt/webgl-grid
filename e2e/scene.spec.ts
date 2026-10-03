import { expect, test } from './fixtures/test';
import { emptySpot, open, screenPosOf, uiState, type Win } from './helpers';

// 3D ビューポート・メニュー・プロパティ・ビューポートのサイドバー (N パネル) の基本操作
test.describe('ビューポート', () => {
  test('最初の画面: 何も置いていない (置き方の案内が出る)、Blender 風の領域 (ビューポート・アウトライナー・プロパティ・タイムライン・状態バー)、何も選んでいない', async ({ page }) => {
    const errors = await open(page, { cube: false });
    expect(await page.evaluate(() => (window as Win).engine.world.objects.length)).toBe(0);
    await expect(page.locator('.view-hint')).toContainText('Shift+A');
    await expect(page.getByRole('tree', { name: 'シーンの物' })).toContainText('何も置いていません');
    await expect(page.getByRole('button', { name: 'ファイル' })).toBeVisible();
    await expect(page.getByRole('region', { name: '3D ビューポート' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'タイムライン' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'アウトライナー' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'プロパティ' })).toBeVisible();
    await expect(page.getByRole('contentinfo', { name: '状態バー' })).toContainText('オブジェクト 0/0');
    await expect(page.getByRole('tablist', { name: 'ワークスペース' }).getByRole('tab', { name: 'レイアウト' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('group', { name: 'カメラの操作' })).toBeVisible(); // ツールバー
    await expect(page.getByRole('complementary', { name: 'サイドバー' })).toHaveCount(0); // N パネルは最初は閉じている
    await expect(page.locator('.view-info')).toHaveText(/ユーザー・透視投影/);
    await expect(page.getByText('何も選んでいません。ビューポートで物をクリックすると選べます。')).toBeVisible();
    const s = await uiState(page);
    expect(s).toMatchObject({ frame: 0, start: 0, end: 250, playing: false, sel: null });
    // WebGL で描けている (エラーが出ていない)
    expect(await page.evaluate(() => (window as Win).engine.viewport.renderer.getContext().getError())).toBe(0);
    expect(errors).toEqual([]);
  });

  test('追加メニューで形を置くと、それが選ばれてプロパティに出る', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: '追加' }).click();
    await page.getByRole('menuitem', { name: 'トーラス' }).click();
    await expect(page.getByRole('menu')).toHaveCount(0); // 選んだらメニューは閉じる
    expect(await page.evaluate(() => (window as Win).engine.world.objects.length)).toBe(2);
    await expect.poll(async () => (await uiState(page)).sel?.name).toBe('トーラス');
    await expect(page.locator('#obj-name')).toHaveValue('トーラス');
  });

  test('Shift+A で追加メニューが開き、Esc で閉じる', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Shift+A');
    await expect(page.getByRole('menuitem', { name: '三角錐' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('クリックで選び、何もない所のクリックで選択を解除する', async ({ page }) => {
    await open(page);
    const p = await screenPosOf(page, 0);
    await page.mouse.click(p.x, p.y);
    await expect.poll(async () => (await uiState(page)).sel?.name).toBe('立方体');
    const e = await emptySpot(page);
    await page.mouse.click(e.x, e.y);
    await expect.poll(async () => (await uiState(page)).sel).toBeNull();
  });

  test('ドラッグで運ぶと、ほかの物の上に積める', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: '追加' }).click();
    await page.getByRole('menuitem', { name: '立方体' }).click();
    const from = await screenPosOf(page, 1), to = await screenPosOf(page, 0);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
    // 落ち着くまで待ってから、上に載った高さを見る
    await expect.poll(() => page.evaluate(() => (window as Win).engine.world.objects[1].y)).toBeCloseTo(1, 3);
  });

  test('X で選んだ物を削除する', async ({ page }) => {
    await open(page);
    const p = await screenPosOf(page, 0);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press('x');
    expect(await page.evaluate(() => (window as Win).engine.world.objects.length)).toBe(0);
    await expect.poll(async () => (await uiState(page)).sel).toBeNull();
  });

  test('プロパティ (オブジェクトのタブ) で位置と色を変えられる', async ({ page }) => {
    await open(page);
    const p = await screenPosOf(page, 0);
    await page.mouse.click(p.x, p.y);
    await page.getByRole('spinbutton', { name: '位置 X' }).fill('3');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => (window as Win).engine.world.objects[0].x)).toBe(3);
    await page.getByRole('button', { name: '青', exact: true }).click();
    expect(await page.evaluate(() => (window as Win).engine.world.objects[0].c)).toBe(3);
  });

  test('テンキー 7 で上から、Home で元の視点に戻る。N でビューポートのサイドバー (N パネル) を開け閉めする', async ({ page }) => {
    await open(page);
    await page.locator('canvas#c').hover();
    await page.keyboard.press('Numpad7');
    await expect(page.locator('.view-info')).toHaveText(/上・透視投影/);
    await page.keyboard.press('Home');
    await expect(page.locator('.view-info')).toHaveText(/ユーザー・透視投影/);
    const npanel = page.getByRole('complementary', { name: 'サイドバー' });
    await expect(npanel).toHaveCount(0);
    await page.keyboard.press('n');
    await expect(npanel).toBeVisible();
    await expect(page.locator('#side-column')).toBeVisible(); // (アウトライナーとプロパティはそのまま)
    // アイテム: 選んでいる物の位置を変えられる
    await page.getByRole('tree', { name: 'シーンの物' }).getByRole('treeitem', { name: '立方体' }).locator(':scope > .ol-row').click();
    await npanel.getByRole('spinbutton', { name: '位置 X (サイドバー)' }).fill('2');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => (window as Win).engine.world.objects[0].x)).toBe(2);
    // ビュー: 視野角
    await npanel.getByRole('tab', { name: 'ビュー' }).click();
    const fov = () => page.evaluate(() => (window as Win).engine.camera.cam.fov);
    const before = await fov();
    await npanel.getByRole('slider', { name: '視野角' }).focus();
    await page.keyboard.press('ArrowRight');
    expect(await fov()).toBeGreaterThan(before);
    await page.locator('canvas#c').hover();
    await page.keyboard.press('n');
    await expect(npanel).toHaveCount(0);
  });

  test('ファイル > 最初の状態に戻す で、何も置いていない場面に戻る', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: '追加' }).click();
    await page.getByRole('menuitem', { name: '三角錐' }).click();
    await page.getByRole('button', { name: 'ファイル' }).click();
    await page.getByRole('menuitem', { name: '最初の状態に戻す' }).click();
    expect(await page.evaluate(() => (window as Win).engine.world.objects.length)).toBe(0);
    await expect(page.locator('.view-hint')).toBeVisible();
    // 置くと案内は消える
    await page.keyboard.press('Shift+A');
    await page.getByRole('menuitem', { name: '立方体' }).click();
    await expect(page.locator('.view-hint')).toHaveCount(0);
  });
});

test.describe('効果', () => {
  test('効果をオンにすると後処理で描き、設定は再読み込みしても残る', async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: '効果' }).click();
    await page.getByRole('checkbox', { name: '光るを使う' }).check();
    await expect.poll(() => page.evaluate(() => !!(window as Win).engine.effects.fx)).toBe(true);
    // オフの効果のスライダーを動かすと、その効果がオンになる
    const slider = page.getByRole('slider', { name: '彩度' });
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('checkbox', { name: '色調を使う' })).toBeChecked();
    await page.reload();
    await page.getByRole('tab', { name: '効果' }).click();
    await expect(page.getByRole('checkbox', { name: '光るを使う' })).toBeChecked();
    await expect(page.getByRole('slider', { name: '彩度' })).toHaveAttribute('aria-valuenow', '0.98');
  });
});
