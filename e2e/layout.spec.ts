import { expect, test } from './fixtures/test';
import { loadTestModel, open } from './helpers';

// Blender 風の画面: 右の列 (アウトライナー・プロパティ)、プロパティのタブ (選んでいる物に合うものだけ)、ワークスペース、状態バー
const tabs = (page: import('@playwright/test').Page) => page.getByRole('tablist', { name: 'プロパティのタブ' }).getByRole('tab');

test('プロパティのタブは、選んでいる物に使えるものだけ出し、使えないタブからはオブジェクトに戻る', async ({ page }) => {
  await open(page, { cube: false });
  await expect(page.getByRole('region', { name: 'アウトライナー' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'プロパティ' })).toBeVisible();
  // 何も選んでいない: 場面のタブとオブジェクトだけ
  const names = async () => (await tabs(page).evaluateAll(els => els.map(e => e.getAttribute('aria-label'))));
  expect(await names()).toEqual(['効果', '出力', 'シーン', 'オブジェクト']);
  // 形: モディファイアーとマテリアル
  await page.keyboard.press('Shift+A');
  await page.getByRole('menuitem', { name: '立方体' }).click();
  await expect.poll(names).toEqual(['効果', '出力', 'シーン', 'オブジェクト', 'モディファイアー', 'マテリアル']);
  await page.getByRole('tab', { name: 'モディファイアー' }).click();
  await expect(page.getByRole('checkbox', { name: 'クローナーにする' })).toBeVisible();
  await expect(page.locator('.props-path')).toContainText('立方体');
  // ライトを置くと、ライトのタブを開く
  await page.keyboard.press('Shift+A');
  await page.getByRole('menuitem', { name: 'ポイント' }).click();
  await expect(page.getByRole('tab', { name: 'ライト' })).toHaveAttribute('aria-selected', 'true');
  expect(await names()).not.toContain('モディファイアー');
  // MMD モデル: 物理演算・表情・ボーンも
  await loadTestModel(page);
  await expect.poll(names).toEqual(['効果', '出力', 'シーン', 'オブジェクト', 'モディファイアー', '物理演算', '表情', 'ボーン', 'マテリアル']);
  await page.getByRole('tab', { name: 'ボーン' }).click();
  // 何も選ばないと、ボーンのタブはなくなり、オブジェクトを見せる (選び直すとボーンに戻る)
  await page.keyboard.press('Alt+a');
  await expect(page.getByRole('tab', { name: 'オブジェクト' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tree', { name: 'シーンの物' }).getByRole('treeitem', { name: 'テスト人形' }).locator(':scope > .ol-row').click();
  await expect(page.getByRole('tab', { name: 'ボーン' })).toHaveAttribute('aria-selected', 'true');
});

test('ワークスペース: シェーディングでシェーダーエディターとマテリアル、レイアウトでタイムラインに戻る。状態バーに数が出る', async ({ page }) => {
  await open(page);
  const ws = page.getByRole('tablist', { name: 'ワークスペース' });
  await expect(ws.getByRole('tab', { name: 'レイアウト' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tree', { name: 'シーンの物' }).getByRole('treeitem', { name: '立方体' }).locator(':scope > .ol-row').click();
  await ws.getByRole('tab', { name: 'シェーディング' }).click();
  await expect(page.getByRole('region', { name: 'シェーダーエディター' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'マテリアル' })).toHaveAttribute('aria-selected', 'true');
  await ws.getByRole('tab', { name: 'レイアウト' }).click();
  await expect(page.getByRole('region', { name: 'タイムライン' })).toBeVisible();
  await expect(page.getByRole('contentinfo', { name: '状態バー' })).toContainText('立方体 | オブジェクト 1/1 | フレーム 0');
});

test('T でビューポートのツールバーを隠し・出す。開け閉めは開き直しても覚えている', async ({ page }) => {
  await open(page);
  const tools = page.getByRole('group', { name: 'カメラの操作' });
  await expect(tools).toBeVisible();
  await page.locator('canvas#c').hover();
  await page.keyboard.press('t');
  await expect(tools).toHaveCount(0);
  await expect(page.locator('.viewport')).toHaveClass(/tools-hidden/);
  await open(page);
  await expect(tools).toHaveCount(0);
  // ビューのメニューからも出せる
  await page.getByRole('button', { name: 'ビュー', exact: true }).click();
  await page.getByRole('menuitem', { name: 'ツールバーを出す' }).click();
  await expect(tools).toBeVisible();
});

test('Ctrl+Space で、マウスが乗っているエリアを最大化し、もう一度で戻す', async ({ page }) => {
  await open(page);
  const view = page.getByRole('region', { name: '3D ビューポート' });
  const outliner = page.getByRole('region', { name: 'アウトライナー' });
  const props = page.getByRole('region', { name: 'プロパティ' });
  const timeline = page.getByRole('region', { name: 'タイムライン' });
  const width = async () => (await view.boundingBox())!.width;
  const w0 = await width();
  // 3D ビューポート
  await page.locator('canvas#c').hover();
  await page.keyboard.press('Control+Space');
  await expect(outliner).toBeHidden();
  await expect(timeline).toBeHidden();
  await expect(page.getByRole('contentinfo', { name: '状態バー' })).toContainText('エリアを元に戻す');
  expect(await width()).toBeGreaterThan(w0 + 200);
  await page.keyboard.press('Control+Space');
  await expect(outliner).toBeVisible();
  await expect(timeline).toBeVisible();
  // アウトライナー: プロパティとビューポートを隠して、いっぱいに
  await outliner.hover();
  await page.keyboard.press('Control+Space');
  await expect(props).toBeHidden();
  await expect(view).toBeHidden();
  expect((await outliner.boundingBox())!.height).toBeGreaterThan(400);
  await page.keyboard.press('Control+Space');
  // タイムライン
  await timeline.hover();
  await page.keyboard.press('Control+Space');
  await expect(view).toBeHidden();
  await expect(outliner).toBeHidden();
  expect((await timeline.boundingBox())!.height).toBeGreaterThan(400);
  await page.keyboard.press('Control+Space');
  await expect(view).toBeVisible();
  // ビューのメニューからも
  await page.getByRole('button', { name: 'ビュー', exact: true }).click();
  await page.getByRole('menuitem', { name: 'エリアを最大化' }).click();
  await expect(timeline).toBeHidden();
});
