import { readFile } from 'node:fs/promises';
import { encodeShiftJis } from '../src/core/sjis';
import { expect, test, type Page } from './fixtures/test';
import { uiState, type Win } from './helpers';
import { addPmx, GREEN_FX, objectFx, openMme, setCamera, shoot, type Vec3 } from './mme-helpers';

// MME 互換の欄の「.emm を読む…」「.emm を書き出す」(MME のエフェクト割当ファイル。書式は docs/superpowers/notes/2026-10-05-emm-format.md)

const FACE: Vec3 = [0, 1, 0.2]; // テスト用の .pmx (四角柱) の前の面の真ん中
const SOLID = objectFx('return float4(0.2, 0.4, 0.6, 1.0);'); // 箱の色 (51, 102, 153)
const rgb = async (page: Page) => (await shoot(page, 'png', [FACE])).pixels[0].slice(0, 3);

// MME 互換にして、テスト用の .pmx (テスト人形.pmx) を +z から見えるように置き、フォルダ fx (green.fx・solid.fx) を読み込んで (当てない)、
// 効果のタブを開く
async function scene(page: Page) {
  const errors = await openMme(page);
  await setCamera(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 4.5, ty: 1 });
  await addPmx(page, { flags: 0 });
  await page.evaluate(async ({ green, solid }) => {
    const { engine } = window as Win;
    const files = [['green.fx', green], ['solid.fx', solid]].map(([name, text]) => {
      const f = new File([text], name);
      Object.defineProperty(f, 'webkitRelativePath', { value: `fx/${name}` });
      return f;
    });
    await engine.mme.loadEffect(files, 'green.fx');
  }, { green: GREEN_FX, solid: SOLID });
  await page.getByRole('tab', { name: '効果' }).click();
  return errors;
}

test('.emm を読むと、名前の合う物に割り当てが戻って絵が変わる。場面にない物は警告。取り消すと戻る', async ({ page }) => {
  const errors = await scene(page);
  const before = await rgb(page); // (default.fx の色)
  const emm = ['[Info]', 'Version = 3', '', '[Object]', 'Pmd1 = C:\\MMD\\UserFile\\Model\\テスト人形.pmx', 'Pmd2 = C:\\MMD\\Absent.pmx', '',
    '[Effect]', 'Default = none', 'Pmd1 = C:\\MMD\\fx\\green.fx', 'Pmd2 = none', ''].join('\r\n');
  await page.getByLabel('.emm を選ぶ').setInputFiles({ name: 'scene.emm', mimeType: 'application/octet-stream', buffer: Buffer.from(encodeShiftJis(emm)) });
  await expect.poll(() => rgb(page)).toEqual([0, 255, 0]);
  expect((await uiState(page)).toast).toBe('.emm を読みました (割り当て 1 件。.emm の物 Absent.pmx は場面にないので、その割り当てを飛ばしました)');
  await page.evaluate(async () => { const { engine } = window as Win; engine.history.checkpoint(); await engine.history.undo(); });
  await expect.poll(() => rgb(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test('.emm を書き出すと、いまの割り当てが Shift_JIS・CRLF の .emm になり、読み直すと同じ絵', async ({ page }) => {
  const errors = await scene(page);
  await page.evaluate(() => {
    const { engine } = window as Win;
    const folder = engine.mme.store.folders().find((f: { name: string }) => f.name === 'fx');
    engine.mme.assign(engine.world.objects[0], 'Main', null, { folder: folder.id, path: 'solid.fx' });
  });
  await expect.poll(() => rgb(page)).toEqual([51, 102, 153]);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '.emm を書き出す' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.emm$/);
  const bytes = await readFile(await download.path());
  const text = new TextDecoder('shift_jis').decode(bytes);
  expect(Buffer.from(encodeShiftJis(text)).equals(bytes)).toBe(true);
  expect(text).toBe(['[Info]', 'Version = 3', '', '[Object]', 'Pmd1 = テスト人形.pmx', '', '[Effect]', 'Default = none', 'Pmd1 = fx\\solid.fx', '', ''].join('\r\n'));
  // (外してから読み直すと同じ絵)
  await page.evaluate(() => (window as Win).engine.mme.clearEffects());
  await expect.poll(() => rgb(page)).not.toEqual([51, 102, 153]);
  await page.getByLabel('.emm を選ぶ').setInputFiles({ name: 'back.emm', mimeType: 'application/octet-stream', buffer: bytes });
  await expect.poll(() => rgb(page)).toEqual([51, 102, 153]);
  expect(errors).toEqual([]);
});
