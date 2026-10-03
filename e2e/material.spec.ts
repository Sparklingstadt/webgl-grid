import { readFile } from 'node:fs/promises';
import { MMDParser } from 'three/examples/jsm/libs/mmdparser.module.js';
import { expect, test, type Page } from './fixtures/test';
import { choose, loadTestModel, open, screenPosOf, setColor, type Win } from './helpers';

// マテリアル (Blender と同じ仕組み): スロット・マテリアルの共有・プリンシプル BSDF・シェーダーエディター・.pmx の書き出し
const active = (page: Page) => page.evaluate(() => {
  const m = (window as Win).engine.materials.active();
  if (!m) return null;
  return { id: m.id, name: m.name, nodes: m.tree.nodes.map((n: { type: string }) => n.type),
           links: m.tree.links.map((l: { from: { socket: string }; to: { socket: string } }) => `${l.from.socket}->${l.to.socket}`) };
});
async function selectCube(page: Page) {
  const p = await screenPosOf(page, 0);
  await page.mouse.click(p.x, p.y);
  await page.getByRole('tab', { name: 'マテリアル' }).click();
}

test('形のマテリアル: 名前・ベースカラー・新規・ほかの物と共有', async ({ page }) => {
  const errors = await open(page);
  await selectCube(page);
  await expect(page.getByRole('listbox', { name: 'マテリアルスロット' }).getByRole('option')).toHaveText(['マテリアル']);
  // 名前を変える
  await page.getByRole('textbox', { name: 'マテリアルの名前' }).fill('木');
  await page.keyboard.press('Enter');
  expect((await active(page))!.name).toBe('木');
  // サーフェスのベースカラー
  await setColor(page, 'ベースカラー', '#ff0000');
  expect(await page.evaluate(() => {
    const { engine } = window as Win;
    return engine.materials.surfaceShader().values.baseColor.map((v: number) => +v.toFixed(3));
  })).toEqual([1, 0, 0]);
  // 立方体をもう 1 つ置いて、同じマテリアルを入れる (共有)
  await page.getByRole('button', { name: '追加' }).click();
  await page.getByRole('menuitem', { name: '立方体' }).click();
  await choose(page, 'スロットのマテリアル', '木');
  await expect(page.getByText('ほかの物とも共有しています')).toBeVisible();
  expect(await page.evaluate(() => { const { engine } = window as Win; return engine.library.users(engine.materials.active().id); })).toBe(2);
  // 新規: 新しいマテリアルに替わり、木は 1 つの物だけに戻る
  await page.getByRole('button', { name: '新規', exact: true }).click();
  expect((await active(page))!.name).toMatch(/^マテリアル/);
  await expect(page.getByText('ほかの物とも共有しています')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('シェーダーエディター: 開く・ノードを足す・マウスでつなぐ・X で消す', async ({ page }) => {
  const errors = await open(page);
  await selectCube(page);
  await page.getByRole('button', { name: 'シェーダーエディターで開く' }).last().click();
  const editor = page.getByRole('region', { name: 'シェーダーエディター' });
  await expect(editor.getByRole('group', { name: 'ノード プリンシプル BSDF' })).toBeVisible();
  await expect(editor.getByRole('group', { name: 'ノード マテリアル出力' })).toBeVisible();
  // 追加メニューから RGB を足し、カラーの出力をベースカラーの入力へドラッグでつなぐ
  await editor.getByRole('button', { name: '追加' }).click();
  await page.getByRole('menuitem', { name: 'RGB' }).click();
  const rgb = editor.getByRole('group', { name: 'ノード RGB' });
  await expect(rgb).toBeVisible();
  // RGB は真ん中に置かれるので、見出しをドラッグして左へずらす
  const head = (await rgb.locator('.node-header').boundingBox())!;
  await page.mouse.move(head.x + 20, head.y + 10);
  await page.mouse.down();
  await page.mouse.move(head.x - 200, head.y + 120, { steps: 6 });
  await page.mouse.up();
  const from = (await editor.getByLabel('RGB の出力 カラー').boundingBox())!;
  const to = (await editor.getByLabel('プリンシプル BSDF の入力 ベースカラー').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  expect((await active(page))!.links).toContain('color->baseColor');
  // サイドバーのサーフェスには、つながっている相手が出る
  await expect(page.getByRole('button', { name: '← RGB' })).toBeVisible();
  // RGB を選んで X で消すと、つながりも消える
  await rgb.locator('.node-header').click();
  await page.keyboard.press('x');
  await expect(rgb).toHaveCount(0);
  expect((await active(page))!.links).toEqual(['bsdf->surface']);
  // マテリアル出力は消せない
  await editor.getByRole('group', { name: 'ノード マテリアル出力' }).locator('.node-header').click();
  await page.keyboard.press('x');
  await expect(editor.getByRole('group', { name: 'ノード マテリアル出力' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('MMD モデルの材質はプリンシプル BSDF に変換され、変えた色を .pmx に書き出せる', async ({ page }) => {
  const errors = await open(page);
  await loadTestModel(page);
  await page.getByRole('tab', { name: 'マテリアル' }).click();
  await expect(page.getByRole('listbox', { name: 'マテリアルスロット' }).getByRole('option')).toHaveText(['体']);
  expect((await active(page))!.nodes).toEqual(['principled', 'output']);
  await setColor(page, 'ベースカラー', '#336699');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'マテリアルを反映した .pmx を書き出す' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('テスト人形_edited.pmx');
  const bytes = await readFile((await download.path())!);
  const pmx = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), false);
  expect(Array.from(pmx.materials[0].diffuse as number[]).slice(0, 3).map(v => Math.round(v * 255))).toEqual([0x33, 0x66, 0x99]);
  expect(pmx.bones.map((b: { name: string }) => b.name)).toContain('右腕'); // ほかの部分はそのまま
  expect(errors).toEqual([]);
});
