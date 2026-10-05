import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FX_DIR } from '../playwright.config';
import { expect, test, type Page } from './fixtures/test';
import { type Win } from './helpers';
import { addPmx, objectFx, openMme, setCamera, shoot, type Vec3 } from './mme-helpers';

// fx/ の一覧: サーバーが fx/ (テストでは環境変数 WEBGL_GRID_FX_DIR の自作のフォルダ) の一覧とファイルを渡し、
// 「fx/ から選ぶ」で選んだフォルダを、フォルダを選んだときと同じように読んで物に当てる。fx/ の外は渡さない。サーバーがなければ選択肢を出さない

// (どのテストも同じ fx フォルダを使うので、順に動かす)
test.describe.configure({ mode: 'serial' });

const FACE: Vec3 = [0, 1, 0.2]; // テスト用の .pmx (四角柱) の前の面の真ん中
const SOLID = '#include "color.fxsub"\n' + objectFx('return solidColor();'); // 色は #include したファイルから (51, 102, 153)
const SOLID_COLOR = 'float4 solidColor() { return float4(0.2, 0.4, 0.6, 1.0); }';
const RED = objectFx('return float4(1.0, 0.0, 0.0, 1.0);');
const BLUE = objectFx('return float4(0.0, 0.0, 1.0, 1.0);');

async function put(files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(FX_DIR, name)), { recursive: true });
    await writeFile(path.join(FX_DIR, name), text);
  }
}
test.beforeEach(async () => {
  await rm(FX_DIR, { recursive: true, force: true });
  await put({
    '自作/solid.fx': SOLID, '自作/color.fxsub': SOLID_COLOR, '自作/Textures/note.txt': 'x',
    'Multi/a.fx': RED, 'Multi/b.fx': BLUE,
    '単体.fx': RED, 'README.md': '# fx',
    '.hidden/h.fx': RED, '無関係/メモ.txt': 'メモ',
  });
});
test.afterEach(async () => { await rm(FX_DIR, { recursive: true, force: true }); });

const panel = (page: Page) => page.locator('details.panel').filter({ has: page.locator('summary', { hasText: /^MME 互換$/ }) });
const rgb = async (page: Page) => (await shoot(page, 'png', [FACE])).pixels[0].slice(0, 3);

// MME 互換にして、テスト用の .pmx (箱) を +z から見えるように置いて選ぶ。効果のタブを開く
async function boxScene(page: Page) {
  const errors = await openMme(page);
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  const i = await addPmx(page, { flags: 0 });
  await page.evaluate(i => { const { engine } = window as Win; engine.selection.select(engine.world.objects[i]); }, i);
  await page.getByRole('tab', { name: '効果' }).click();
  return errors;
}

test('サーバーは、fx/ の直下のフォルダごとの .fx とファイルの一覧を渡し、fx/ の外・隠しファイル・リンクの先は渡さない', async ({ page }) => {
  const res = await page.request.get('__fx');
  expect(res.headers()['content-type']).toContain('json');
  const { folders } = await res.json();
  const by = Object.fromEntries(folders.map((f: { name: string }) => [f.name, f]));
  // (.fx のない 無関係/ と、隠しフォルダは出ない。fx/ の直下のファイルは fx という名前のフォルダに)
  expect(Object.keys(by).sort()).toEqual(['Multi', 'fx', '自作']);
  expect(by['自作']).toMatchObject({ dir: '自作', fx: ['solid.fx'], files: ['Textures/note.txt', 'color.fxsub', 'solid.fx'] });
  expect(by['Multi']).toMatchObject({ dir: 'Multi', fx: ['a.fx', 'b.fx'] });
  expect(by['fx']).toMatchObject({ dir: '', fx: ['単体.fx'], files: ['README.md', '単体.fx'] });
  // ファイル
  const file = (p: string) => page.request.get(`__fx/file?path=${encodeURIComponent(p)}`);
  const ok = await file('自作/color.fxsub');
  expect(ok.status()).toBe(200);
  expect(await ok.text()).toBe(SOLID_COLOR);
  expect((await file('単体.fx')).status()).toBe(200);
  // fx/ の外・絶対パス・隠しファイル・fx/ から外を指すリンクは渡さない
  await symlink(path.resolve('package.json'), path.join(FX_DIR, '自作', 'link.fx'));
  for (const bad of ['../package.json', '../../package.json', '自作/../../../package.json', path.resolve('package.json'), '/etc/passwd', '.hidden/h.fx', '自作/link.fx', '', '自作', '自作\\..\\..\\package.json']) {
    expect((await file(bad)).status(), bad).toBe(404);
  }
  expect((await page.request.get('__fx/file?path=..%2F..%2Fpackage.json')).status()).toBe(404);
  expect((await page.request.get('__fx/file')).status()).toBe(404);
});

test('「fx/ から選ぶ」で選んだフォルダを読んで、選んでいる物に当てる (#include のファイルも渡る。.fx がいくつかあれば選ばせる)', async ({ page }) => {
  const errors = await boxScene(page);
  const before = await rgb(page); // (default.fx の色)
  const p = panel(page);
  const open = () => p.getByRole('button', { name: 'fx/ から選ぶ' }).first(); // (最初は物の .fx、次がポストエフェクト)
  await expect(p.getByRole('button', { name: 'fx/ から選ぶ' })).toHaveCount(2);
  await open().click();
  const dialog = page.getByRole('dialog', { name: 'fx/ のフォルダ' });
  const list = dialog.getByRole('group', { name: 'fx/ のフォルダの一覧' });
  await expect(list.getByRole('button')).toHaveText([/^fx\s+\.fx 1 個/, /^Multi\s+\.fx 2 個/, /^自作\s+\.fx 1 個/]);
  await page.keyboard.press('x'); // (窓のあいだは、場面のショートカット (X で消す) を効かせない)
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as Win).engine.world.objects.length)).toBe(1);
  // .fx が 1 つのフォルダは、選ばずに読む。色は #include したファイルのもの
  await open().click();
  await list.getByRole('button', { name: /^自作/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(p).toContainText('自作/solid.fx');
  await expect(p).toContainText('コンパイルできました');
  await expect.poll(() => rgb(page)).toEqual([51, 102, 153]);
  // フォルダを選んだときと同じ形: 名前は フォルダ/パス で、フォルダの中のファイルは全部入る
  expect(await page.evaluate(() => {
    const folder = (window as Win).engine.mme.store.folders().find((f: Win) => f.name === '自作');
    return folder && [...folder.files.keys()].sort();
  })).toEqual(['Textures/note.txt', 'color.fxsub', 'solid.fx']);
  // .fx がいくつかあるフォルダは、選ばせる
  await open().click();
  await list.getByRole('button', { name: /^Multi/ }).click();
  const choice = page.getByRole('dialog', { name: '.fx を選ぶ' });
  await expect(choice.getByRole('button')).toHaveText(['a.fx', 'b.fx', 'やめる (Esc)']);
  await choice.getByRole('button', { name: 'b.fx' }).click();
  await expect(p).toContainText('Multi/b.fx');
  await expect.poll(() => rgb(page)).toEqual([0, 0, 255]);
  // fx/ の直下のファイルは、fx という名前のフォルダに
  await open().click();
  await list.getByRole('button', { name: /^fx/ }).click();
  await expect(p).toContainText('fx/単体.fx');
  await expect.poll(() => rgb(page)).toEqual([255, 0, 0]);
  // 外す: default.fx に戻る
  await p.getByRole('button', { name: '外す', exact: true }).click();
  await expect.poll(() => rgb(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test('ポストエフェクトの「足す…」にも「fx/ から選ぶ」があり、読み込めなければお知らせが出る', async ({ page }) => {
  const errors = await boxScene(page);
  const p = panel(page);
  // 一覧に出してから、ファイルを渡せなくする (選んだフォルダのファイルが 1 つ読めない)
  await p.getByRole('button', { name: 'fx/ から選ぶ' }).nth(1).click();
  await page.route('**/__fx/file*', r => r.fulfill({ status: 404 }));
  await page.getByRole('dialog', { name: 'fx/ のフォルダ' }).getByRole('button', { name: /^自作/ }).click();
  await expect(page.getByRole('status').filter({ hasText: '読み込めませんでした' })).toContainText(/自作 を読み込めませんでした: /);
  await expect(page.getByRole('dialog', { name: 'fx/ のフォルダ' })).toBeVisible(); // (読めなければ窓は閉じない)
  await page.unroute('**/__fx/file*');
  await page.getByRole('dialog', { name: 'fx/ のフォルダ' }).getByRole('button', { name: /^自作/ }).click();
  await expect(page.getByRole('dialog', { name: 'fx/ のフォルダ' })).toHaveCount(0);
  await expect(p.getByRole('list', { name: 'ポストエフェクトの一覧' })).toContainText('自作/solid.fx');
  expect(errors.filter(e => !e.includes('404'))).toEqual([]);
});

test('MCP の命令 mme_list_fx・mme_load_folder は、サーバーの fx/ の一覧から選んだフォルダを読み込む (読み込むだけ。.fx のパスで割り当てられる)', async ({ page }) => {
  const errors = await openMme(page);
  const run = (name: string, params: unknown = {}) => page.evaluate(async ({ name, params }) => {
    const { engine } = window as Win;
    try { return { ok: await engine.addons.commands.get(name).run(engine, params) }; } catch (err) { return { error: (err as Error).message }; }
  }, { name, params });
  const listed = (await run('mme_list_fx')).ok;
  expect(listed.folders.map((f: { name: string; fx: string[]; loaded: boolean }) => [f.name, f.fx, f.loaded])).toEqual([
    ['fx', ['単体.fx'], false], ['Multi', ['a.fx', 'b.fx'], false], ['自作', ['solid.fx'], false],
  ]);
  expect((await run('mme_load_folder', { folder: '無関係' })).error).toContain('fx/ にフォルダ 無関係 はありません');
  const loaded = (await run('mme_load_folder', { folder: '自作' })).ok;
  expect(loaded).toMatchObject({ folder: { name: '自作' }, fx: ['solid.fx'] });
  // (#include のファイルも渡っているので、コンパイルできる)
  const acc = (await run('mme_add_accessory', { name: 'solid.x', fx: { folder: '自作', path: 'solid.fx' } })).ok;
  const state = (await run('mme_state')).ok;
  expect(state.folders).toEqual([{ id: loaded.folder.id, name: '自作', fx: ['solid.fx'] }]);
  expect(state.accessories).toEqual([expect.objectContaining({ id: acc.id, ok: true, fx: { folder: loaded.folder.id, folderName: '自作', path: 'solid.fx' } })]);
  expect((await run('mme_list_fx')).ok.folders.find((f: { name: string }) => f.name === '自作').loaded).toBe(true);
  expect(errors).toEqual([]);
});

test('サーバーが一覧を答えないとき (静的に配っている・fx/ にエフェクトがない) は、「fx/ から選ぶ」を出さない', async ({ page }) => {
  // 一覧がない: 404 と、ページを返すだけのサーバー (SPA の入口)
  for (const fulfill of [{ status: 404 }, { status: 200, contentType: 'text/html', body: '<!doctype html><title>x</title>' }]) {
    await page.route('**/__fx', r => r.fulfill(fulfill));
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    await boxScene(page);
    await expect(panel(page).getByLabel('物の .fx のフォルダを選ぶ')).toHaveCount(1);
    await expect(panel(page).getByRole('button', { name: '読み込む…' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'fx/ から選ぶ' })).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.unroute('**/__fx');
  }
  // fx/ にエフェクトがない
  await rm(FX_DIR, { recursive: true, force: true });
  await boxScene(page);
  await expect(panel(page).getByRole('button', { name: '読み込む…' })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'fx/ から選ぶ' })).toHaveCount(0);
});

test('一部だけの一覧 (truncated) のフォルダは、一覧に「一部だけ」と出て、読み込むとお知らせが出る。fx/ の中の fx フォルダと直下のファイルは混ざらない', async ({ page }) => {
  await put({ 'fx/inner.fx': BLUE });
  // (サーバーの上限は大きいので、一覧の答えを書き換えて、自作/ を一部だけにする)
  const real = await (await page.request.get('__fx')).json();
  expect(real.folders.map((f: { name: string }) => f.name).sort()).toEqual(['Multi', 'fx', 'fx (直下のファイル)', '自作']);
  await page.route('**/__fx', r => r.fulfill({ json: { folders: real.folders.map((f: { name: string }) => (f.name === '自作' ? { ...f, truncated: true } : f)) } }));
  const errors = await boxScene(page);
  const p = panel(page);
  await p.getByRole('button', { name: 'fx/ から選ぶ' }).first().click();
  const list = page.getByRole('dialog', { name: 'fx/ のフォルダ' }).getByRole('group', { name: 'fx/ のフォルダの一覧' });
  await expect(list.getByRole('button', { name: /^自作/ })).toContainText('一部だけ');
  await expect(list.getByRole('button', { name: /^Multi/ })).not.toContainText('一部だけ');
  await list.getByRole('button', { name: /^自作/ }).click();
  await expect(page.getByRole('status').filter({ hasText: '一部だけ読み込みました' })).toContainText('自作 はファイルが多いか深すぎるので');
  // 別のフォルダ: fx/inner.fx (フォルダ fx) と 単体.fx (フォルダ fx (直下のファイル)) は別のフォルダ
  await p.getByRole('button', { name: 'fx/ から選ぶ' }).first().click();
  await list.getByRole('button', { name: /^fx \(直下のファイル\)/ }).click();
  await expect(p).toContainText('fx (直下のファイル)/単体.fx');
  await p.getByRole('button', { name: 'fx/ から選ぶ' }).first().click();
  await list.getByRole('button', { name: /^fx\s+\.fx/ }).click();
  await expect(p).toContainText('fx/inner.fx');
  expect(await page.evaluate(() => (window as Win).engine.mme.store.folders().map((f: Win) => f.name).sort())).toEqual(['fx', 'fx (直下のファイル)', '自作']);
  expect(errors).toEqual([]);
});
