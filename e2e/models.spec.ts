import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MODELS_DIR } from '../playwright.config';
import { expect, test } from './fixtures/test';
import { makePmx } from './fixtures/pmx';
import { makeVmd } from './fixtures/vmd';
import { encodeShiftJis } from '../src/core/sjis';
import { formatVpd } from '../src/core/vpdFormat';
import { type Win } from './helpers';

// (どのテストも同じ models フォルダを使うので、順に動かす)
test.describe.configure({ mode: 'serial' });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

test('起動したとき、models フォルダのモデル・モーション・ポーズを一覧から選ぶと、テクスチャ付きで読み込み、モーションとポーズを付ける', async ({ page }) => {
  // テスト用の models フォルダに、モデル (と、別のフォルダのテクスチャ) を置く
  const dir = path.join(MODELS_DIR, 'フォルダ人形');
  await rm(MODELS_DIR, { recursive: true, force: true });
  await mkdir(path.join(dir, 'tex'), { recursive: true });
  await writeFile(path.join(dir, 'フォルダ人形.pmx'), makePmx('フォルダ人形', { texture: 'tex\\body.png' }));
  await writeFile(path.join(dir, 'tex', 'body.png'), PNG);
  // モーション: モデルのフォルダの中と、別のフォルダに (モデルを読み込むときは、勝手に付けない)
  const vmd = Buffer.from(makeVmd([{ bone: 'センター', frame: 0, pos: [0, 0, 0] }, { bone: 'センター', frame: 30, pos: [0, 0, 6] }]));
  await writeFile(path.join(dir, '踊り.vmd'), vmd);
  await mkdir(path.join(MODELS_DIR, 'モーション'), { recursive: true });
  await writeFile(path.join(MODELS_DIR, 'モーション', '歩く.vmd'), vmd);
  // ポーズと表情 (.vpd。MMD と同じ Shift-JIS): 右腕を 30 度、まばたきを 1 に
  const zero = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };
  await mkdir(path.join(MODELS_DIR, 'ポーズ'), { recursive: true });
  await writeFile(path.join(MODELS_DIR, 'ポーズ', '腕を上げる.vpd'),
    encodeShiftJis(formatVpd('フォルダ人形', { bones: [{ name: '右腕', value: { ...zero, rz: 30 } }], morphs: [{ name: 'まばたき', weight: 1 }] })));
  try {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto('/?debug');
    const picker = page.getByRole('region', { name: 'models フォルダのモデル' });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('list', { name: 'モデルの一覧' }).getByRole('button', { name: /フォルダ人形/ })).toContainText('テクスチャ 1 枚');
    // (サーバーは、models フォルダの外のファイルを渡さない)
    expect((await page.request.get('__models/file?path=../../package.json')).status()).toBe(404);
    await expect(picker.getByRole('list', { name: 'モーションの一覧' }).getByRole('button')).toHaveText([/踊り/, /歩く/]); // (フォルダの名前の順)
    await picker.getByRole('list', { name: 'モデルの一覧' }).getByRole('button', { name: /フォルダ人形/ }).click();
    await expect.poll(() => page.evaluate(() => (window as Win).engine.world.models.length)).toBe(1);
    await expect(picker).toBeVisible(); // (続けてモーションを選べるよう、閉じない)
    // テクスチャは見つかったので、探す窓は出ない
    await expect(page.getByRole('dialog', { name: 'テクスチャを探す' })).toHaveCount(0);
    expect(await page.evaluate(() => {
      const { engine } = window as Win;
      const m = engine.world.models[0];
      return [m.model.name, m.animated ?? false, engine.library.materials.get(m.slots[0]).tree.nodes.filter((n: Win) => n.type === 'image').length];
    })).toEqual(['フォルダ人形', false, 1]);
    // ポーズを選ぶと、選んでいるモデルにポーズと表情を当てる
    await picker.getByRole('list', { name: 'ポーズの一覧' }).getByRole('button', { name: /腕を上げる/ }).click();
    await expect.poll(() => page.evaluate(() => {
      const m = (window as Win).engine.world.models[0];
      const arm = m.model.skeleton.bones.findIndex((b: { name: string }) => b.name === '右腕');
      return [Math.round(m.pose?.get(arm)?.rz ?? 0), m.model.morphTargetInfluences[m.model.morphTargetDictionary['まばたき']]];
    })).toEqual([30, 1]);
    // モーションを選ぶと、選んでいるモデルに付く
    await expect(picker).toContainText('選んでいる フォルダ人形 に付けます');
    await picker.getByRole('button', { name: /歩く/ }).click();
    await expect.poll(() => page.evaluate(() => (window as Win).engine.world.models[0].animated)).toBe(true);
    // 閉じて、ファイル > models フォルダから読み込む… でも開ける
    await picker.getByRole('button', { name: '閉じる' }).click();
    await expect(picker).toBeHidden();
    await page.getByRole('button', { name: 'ファイル' }).click();
    await page.getByRole('menuitem', { name: 'models フォルダから読み込む…' }).click();
    await expect(picker).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await rm(MODELS_DIR, { recursive: true, force: true });
  }
});

test('起動したとき、げのげ式初音ミク.pmx があればまず読み込み (一覧は出さない)、読み込めなければ一覧から選ぶ', async ({ page }) => {
  // (中身はテスト用の人形。ファイル名だけを決まったモデルと同じにする)
  const dir = path.join(MODELS_DIR, 'げのげ式初音ミク');
  await rm(MODELS_DIR, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'げのげ式初音ミク.pmx'), makePmx('初音ミク', { texture: 'body.png' }));
  await writeFile(path.join(dir, 'body.png'), PNG);
  await mkdir(path.join(MODELS_DIR, 'フォルダ人形'), { recursive: true });
  await writeFile(path.join(MODELS_DIR, 'フォルダ人形', 'フォルダ人形.pmx'), makePmx('フォルダ人形'));
  try {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto('/?debug');
    await expect.poll(() => page.evaluate(() => (window as Win).engine?.world.models.map((m: Win) => m.model.name) ?? [])).toEqual(['初音ミク']);
    expect(await page.evaluate(() => (window as Win).engine.history.canUndo)).toBe(false); // (読み込んだ場面が最初の状態)
    const picker = page.getByRole('region', { name: 'models フォルダのモデル' });
    await expect(picker).toHaveCount(0);
    // 読み込めないとき (壊れた .pmx) は、いつもどおり一覧を出す
    await writeFile(path.join(dir, 'げのげ式初音ミク.pmx'), Buffer.from('broken'));
    await page.reload();
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('list', { name: 'モデルの一覧' }).getByRole('button')).toHaveText([/げのげ式初音ミク/, /フォルダ人形/]);
    expect(await page.evaluate(() => (window as Win).engine.world.models.length)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await rm(MODELS_DIR, { recursive: true, force: true });
  }
});
