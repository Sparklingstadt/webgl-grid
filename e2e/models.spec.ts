import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MODELS_DIR } from '../playwright.config';
import { expect, test } from './fixtures/test';
import { makePmx } from './fixtures/pmx';
import { type Win } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

test('起動したとき、models フォルダのモデルを一覧から選ぶと、テクスチャ付きで読み込む', async ({ page }) => {
  // テスト用の models フォルダに、モデル (と、別のフォルダのテクスチャ) を置く
  const dir = path.join(MODELS_DIR, 'フォルダ人形');
  await rm(MODELS_DIR, { recursive: true, force: true });
  await mkdir(path.join(dir, 'tex'), { recursive: true });
  await writeFile(path.join(dir, 'フォルダ人形.pmx'), makePmx('フォルダ人形', { texture: 'tex\\body.png' }));
  await writeFile(path.join(dir, 'tex', 'body.png'), PNG);
  await writeFile(path.join(dir, '踊り.vmd'), 'not used'); // (モーションは勝手に付けない)
  try {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto('/?debug');
    const picker = page.getByRole('region', { name: 'models フォルダのモデル' });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('button', { name: /フォルダ人形/ })).toContainText('テクスチャ 1 枚');
    // (サーバーは、models フォルダの外のファイルを渡さない)
    expect((await page.request.get('__models/file?path=../../package.json')).status()).toBe(404);
    await picker.getByRole('button', { name: /フォルダ人形/ }).click();
    await expect(picker).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as Win).engine.world.models.length)).toBe(1);
    // テクスチャは見つかったので、探す窓は出ない
    await expect(page.getByRole('dialog', { name: 'テクスチャを探す' })).toHaveCount(0);
    expect(await page.evaluate(() => {
      const { engine } = window as Win;
      const m = engine.world.models[0];
      return [m.model.name, m.animated ?? false, engine.library.materials.get(m.slots[0]).tree.nodes.filter((n: Win) => n.type === 'image').length];
    })).toEqual(['フォルダ人形', false, 1]);
    // ファイル > models フォルダから読み込む… でも開ける
    await page.getByRole('button', { name: 'ファイル' }).click();
    await page.getByRole('menuitem', { name: 'models フォルダから読み込む…' }).click();
    await expect(picker).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await rm(MODELS_DIR, { recursive: true, force: true });
  }
});
