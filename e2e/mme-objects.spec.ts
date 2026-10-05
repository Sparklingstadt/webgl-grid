import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/test';
import { open, screenPosOf, uiState, type Win } from './helpers';
import { shoot } from './mme-helpers';

// MME の物 (仮のコントローラー・仮のアクセサリ): 形のない物。アウトライナーには出るが、描かない・ビューポートでは選べない
const tree = (page: Page) => page.getByRole('tree', { name: 'シーンの物' });
const row = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true }).locator(':scope > .ol-row');
const addMme = (page: Page, kind: 'controller' | 'accessory', name: string) => page.evaluate(({ kind, name }) => {
  const { engine } = window as Win;
  engine.addMmeObject({ kind, name });
  engine.viewport.requestDraw();
  return engine.world.objects.length - 1;
}, { kind, name });

test('標準のエンジンの書き出しは、MME の物を置いて選んでも同じ絵', async ({ page }) => {
  const errors = await open(page);
  await page.evaluate(() => (window as Win).engine.output.set({ width: 320, height: 240 }));
  const before = await shoot(page, 'png', [], true);
  await addMme(page, 'controller', 'ray_controller.pmx');
  await addMme(page, 'accessory', 'ray.x'); // (原点 = 立方体と同じ所。選んでいる)
  await expect.poll(async () => (await uiState(page)).sel?.kind).toBe('mme');
  const after = await shoot(page, 'png', [], true);
  expect(after.data.length).toBe(before.data.length);
  let differ = 0;
  for (let i = 0; i < before.data.length; i++) if (before.data[i] !== after.data[i]) differ++;
  expect(differ).toBe(0);
  expect(errors).toEqual([]);
});

test('アウトライナーに出て選べ、名前を変えられる。ビューポートのクリックでは選ばない', async ({ page }) => {
  const errors = await open(page, { cube: false });
  const i = await addMme(page, 'accessory', 'ray.x');
  await expect(row(page, 'ray.x').locator('.ol-icon')).toHaveClass(/ol-mme/);
  // 何もない所をクリックすると選択が外れ、MME の物のある所 (原点) をクリックしても選ばない
  const p = await screenPosOf(page, i);
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await uiState(page)).sel).toBeNull();
  // アウトライナーからは選べる
  await row(page, 'ray.x').click();
  await expect.poll(async () => (await uiState(page)).sel).toMatchObject({ kind: 'mme', name: 'ray.x' });
  // 名前を変えると、照らす名前 (mmeObj の名前) も変わる
  await row(page, 'ray.x').dblclick();
  await page.getByRole('textbox', { name: '名前', exact: true }).first().fill('post.x');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(i => (window as Win).engine.world.objects[i].mmeObj, i)).toEqual({ kind: 'accessory', name: 'post.x' });
  expect(errors).toEqual([]);
});
