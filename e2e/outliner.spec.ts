import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/test';
import { loadTestModel, open, screenPosOf, uiState, type Win } from './helpers';

// アウトライナー (Blender のアウトライナー): サイドバーの上の、置いた物の一覧
const tree = (page: Page) => page.getByRole('tree', { name: 'シーンの物' });
const item = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true });
const row = (page: Page, name: string) => item(page, name).locator(':scope > .ol-row');
const obj = (page: Page, i: number) => page.evaluate(i => {
  const o = (window as Win).engine.world.objects[i];
  return { name: o.name ?? null, hidden: !!o.hidden, hideRender: !!o.hideRender, visible: o.node.visible };
}, i);

test('置いた物を一覧にし、選ぶ・名前を変える・隠す・レンダリングに写さない・絞り込む・消す。元に戻せる', async ({ page }) => {
  const errors = await open(page);
  await expect(tree(page).getByRole('treeitem')).toHaveText(['立方体']);
  await page.getByRole('button', { name: '追加' }).click();
  await page.getByRole('menuitem', { name: 'トーラス' }).click();
  await expect(tree(page).getByRole('treeitem')).toHaveText(['立方体', 'トーラス']);
  await expect(item(page, 'トーラス')).toHaveAttribute('aria-selected', 'true');
  // クリックで選ぶ
  await row(page, '立方体').click();
  await expect.poll(async () => (await uiState(page)).sel?.name).toBe('立方体');
  // ↓ で次の物を選ぶ
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await uiState(page)).sel?.name).toBe('トーラス');
  await expect(item(page, 'トーラス')).toBeFocused();
  // ダブルクリックで名前を変える (サイドバーの名前・ビューポート左上にも出る)
  await row(page, '立方体').dblclick();
  await page.getByRole('textbox', { name: '名前', exact: true }).first().fill('台座');
  await page.keyboard.press('Enter');
  await expect(item(page, '台座')).toBeVisible();
  await expect(page.locator('#obj-name')).toHaveValue('台座');
  await expect(page.locator('.view-info')).toContainText('台座');
  expect((await obj(page, 0)).name).toBe('台座');
  // 目のアイコン: ビューポートで隠すと選択が外れ、クリックしても選べない
  await row(page, '台座').getByRole('button', { name: 'ビューポートで隠す' }).click();
  expect(await obj(page, 0)).toMatchObject({ hidden: true, visible: false });
  await expect.poll(async () => (await uiState(page)).sel).toBeNull();
  await expect(row(page, '台座')).toHaveClass(/hidden/);
  const p = await screenPosOf(page, 0);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(100);
  expect((await uiState(page)).sel).toBeNull();
  // Alt+H で全部見せる
  await page.keyboard.press('Alt+h');
  expect(await obj(page, 0)).toMatchObject({ hidden: false, visible: true });
  // H で選んでいる物を隠す
  await row(page, 'トーラス').click();
  await page.keyboard.press('h');
  expect((await obj(page, 1)).hidden).toBe(true);
  await page.keyboard.press('Alt+h');
  await page.waitForTimeout(200); // (隠す・見せるを、ここまでで 1 手にする)
  // カメラのアイコン: レンダリングに写さない (ビューポートには出ている)。元に戻せる
  await row(page, '台座').getByRole('button', { name: 'レンダリングに写さない' }).click();
  expect(await obj(page, 0)).toMatchObject({ hideRender: true, visible: true });
  await expect.poll(() => page.evaluate(() => (window as Win).engine.ui.state.history.labels.at(-1))).toBe('レンダリングに写さない');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await obj(page, 0)).hideRender).toBe(false);
  // 絞り込み
  await page.getByRole('searchbox', { name: 'アウトライナーを絞り込む' }).fill('台');
  await expect(tree(page).getByRole('treeitem')).toHaveText(['台座']);
  await page.getByRole('searchbox', { name: 'アウトライナーを絞り込む' }).fill('');
  // 右クリックのメニューで消す
  await row(page, 'トーラス').click({ button: 'right' });
  await page.getByRole('menu', { name: 'アウトライナーのメニュー' }).getByRole('menuitem', { name: '削除' }).click();
  await expect(tree(page).getByRole('treeitem')).toHaveText(['台座']);
  expect(errors).toEqual([]);
});

test('MMD モデルを広げるとボーンが並び、押すとボーンのタブでそのボーンを選ぶ。F2 で名前を変える', async ({ page }) => {
  await open(page);
  await loadTestModel(page);
  const model = item(page, 'テスト人形');
  await expect(model).toHaveAttribute('aria-expanded', 'false');
  await model.getByRole('button', { name: 'ボーンを開く' }).click();
  await expect(model.getByRole('treeitem')).toHaveText(['センター', '右腕']); // (ボーンのタブと同じ、動かせるボーン)
  await model.getByRole('treeitem', { name: '右腕' }).click();
  await expect(page.getByRole('tab', { name: 'ボーン' })).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => (window as Win).engine.boneSel())).toBe(1);
  await expect(model.getByRole('treeitem', { name: '右腕' })).toHaveAttribute('aria-selected', 'true');
  // 閉じていても、ボーンの名前で絞り込める
  await model.getByRole('button', { name: 'ボーンを閉じる' }).click();
  await page.getByRole('searchbox', { name: 'アウトライナーを絞り込む' }).fill('右');
  await expect(model.getByRole('treeitem')).toHaveText(['右腕']);
  await page.getByRole('searchbox', { name: 'アウトライナーを絞り込む' }).fill('');
  // F2 (ビューポートの上で): 選んでいる物の名前を変える。サイドバーを閉じていても開く
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('n');
  await expect(tree(page)).toHaveCount(0);
  await page.getByRole('region', { name: '3D ビューポート' }).hover();
  await page.keyboard.press('F2');
  const field = page.getByRole('textbox', { name: '名前', exact: true }).first();
  await expect(field).toBeFocused();
  await field.fill('ミク');
  await page.keyboard.press('Enter');
  await expect(item(page, 'ミク')).toBeVisible();
  await expect.poll(async () => (await uiState(page)).sel?.name).toBe('ミク');
  // 空にすると、元の名前に戻る
  await row(page, 'ミク').dblclick();
  await page.getByRole('textbox', { name: '名前', exact: true }).first().fill('');
  await page.keyboard.press('Enter');
  await expect(item(page, 'テスト人形')).toBeVisible();
});
