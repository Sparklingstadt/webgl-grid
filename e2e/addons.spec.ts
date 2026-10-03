import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures/test';
import { open, type Win } from './helpers';

// アドオン: 編集 > アドオンマネージャー で有効にすると、メニューとプロパティのパネルが足され、
// ファイルからインストールしたアドオンは、ページを開き直しても残る
test('組み込みのアドオンを有効にして使い、切ると消える', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('button', { name: '編集' }).click();
  await page.getByRole('menuitem', { name: 'アドオンマネージャー…' }).click();
  const prefs = page.getByRole('dialog', { name: 'アドオンマネージャー' });
  // Cinema 4D は最初から有効。探す・絞り込む
  await expect(prefs.getByRole('checkbox', { name: 'Cinema 4D を有効にする' })).toBeChecked();
  await prefs.getByRole('searchbox', { name: 'アドオンを探す' }).fill('揺ら');
  await expect(prefs.getByRole('checkbox')).toHaveCount(1);
  await prefs.getByRole('checkbox', { name: 'ふわふわ を有効にする' }).click();
  // 足しているもの
  await prefs.getByRole('button', { name: 'ふわふわ の詳しいこと' }).click();
  await expect(prefs.getByRole('list', { name: 'ふわふわ が足しているもの' })).toContainText('メニュー: オブジェクト > ふわふわさせる / やめる');
  await expect(prefs.getByRole('list', { name: 'ふわふわ が足しているもの' })).toContainText('物ごとの値: ふわふわ');
  await prefs.getByRole('searchbox', { name: 'アドオンを探す' }).fill('');
  await expect(prefs.getByRole('checkbox', { name: 'ふわふわ を有効にする' })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(prefs).toBeHidden();

  // 立方体を選んで「オブジェクト > ふわふわさせる」→ パネルが出て、高さを変えると描く位置が上がる
  await page.evaluate(() => { const { engine } = window as Win; engine.select(engine.world.objects[0]); engine.clock.seekFrame(30); });
  await page.getByRole('button', { name: 'オブジェクト', exact: true }).click();
  await page.getByRole('menuitem', { name: 'ふわふわさせる / やめる' }).click();
  await expect(page.getByRole('checkbox', { name: 'ふわふわさせる' })).toBeChecked();
  await expect(page.getByRole('slider', { name: '高さ' })).toBeVisible();
  const lifted = () => page.evaluate(() => { const { engine } = window as Win; engine.viewport.render(); return +engine.world.objects[0].node.position.y.toFixed(3); });
  expect(await lifted()).toBeCloseTo(0.3); // 1 秒 (周期 2 秒の半分) で一番上
  // 元に戻せる
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('checkbox', { name: 'ふわふわさせる' })).not.toBeChecked();

  // 切ると、メニューとパネルが消える (Ctrl+, でも開ける)
  await page.keyboard.press('Control+,');
  await prefs.getByRole('checkbox', { name: 'ふわふわ を有効にする' }).click();
  await prefs.getByRole('button', { name: '閉じる (Esc)' }).click();
  await expect(page.getByRole('checkbox', { name: 'ふわふわさせる' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('ファイルからアドオンをインストールし、開き直しても使え、消せる', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('button', { name: '編集' }).click();
  await page.getByRole('menuitem', { name: 'アドオンマネージャー…' }).click();
  const prefs = page.getByRole('dialog', { name: 'アドオンマネージャー' });
  await prefs.getByLabel('アドオンのファイル').setInputFiles({ name: 'hello.js', mimeType: 'text/javascript', buffer: await readFile('examples/addons/hello.js') });
  await expect(prefs.getByRole('checkbox', { name: 'ハロー を有効にする' })).toBeChecked();
  await page.keyboard.press('Escape');

  // 追加メニューの項目と、自分のタブのパネル
  await page.getByRole('button', { name: '追加' }).click();
  await page.getByRole('menuitem', { name: '立方体の塔 (5 段)' }).click();
  expect(await page.evaluate(() => (window as Win).engine.world.objects.map((o: Win) => +o.y.toFixed(2)).sort())).toEqual([0, 0, 1, 2, 3, 4]); // 5 段に積む
  await page.getByRole('tab', { name: 'ハロー' }).click();
  await expect(page.getByText('置いてある物: 6 個')).toBeVisible();
  await page.getByRole('button', { name: 'あいさつする' }).click();
  await expect(page.getByText('こんにちは (1 回目)')).toBeVisible();

  // 開き直しても、インストールしたまま有効
  await page.reload();
  await page.waitForFunction(() => (window as Win).engine?.addons.isEnabled('hello'));
  expect(await page.evaluate(() => (window as Win).engine.addons.commands.get('hello.greet').run(null, { name: 'ミク' }))).toBe('こんにちは、ミク');
  await expect(page.getByRole('tab', { name: 'ハロー' })).toBeVisible();

  // 消す
  await page.keyboard.press('Control+,');
  await prefs.getByRole('combobox', { name: '表示するアドオン' }).click();
  await page.getByRole('option', { name: 'インストールしたもの' }).click();
  await expect(prefs.getByRole('checkbox')).toHaveCount(1);
  await prefs.getByRole('button', { name: 'ハロー の詳しいこと' }).click();
  await expect(prefs.getByRole('list', { name: 'ハロー が足しているもの' })).toContainText('MCP の命令: hello.greet');
  await prefs.getByRole('button', { name: '消す' }).click();
  await expect(prefs.getByRole('checkbox', { name: 'ハロー を有効にする' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'ハロー' })).toHaveCount(0);
  expect(errors).toEqual([]);
});
