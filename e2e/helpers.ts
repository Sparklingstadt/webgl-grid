import { expect, type Page } from '@playwright/test';
import { makePmx } from './fixtures/pmx';

// ?debug で開くと、エンジンの中の状態が window から見える (src/engine/index.ts の exposeDebug)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Win = any;

// ページを開き、エンジンが動き出すまで待つ。コンソールのエラーを集めておく
export async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/?debug');
  await page.waitForFunction(() => (window as Win).boxes?.length === 1 && (window as Win).ui);
  return errors;
}

// エンジンの ui ストアの値
export const uiState = (page: Page) => page.evaluate(() => {
  const s = (window as Win).ui.get();
  return { frame: s.frame, playing: s.playing, start: s.start, end: s.end, sel: s.sel, viewInfo: s.viewInfo, toast: s.toast?.text ?? null };
});

// 置いた物 i の真ん中が、画面のどこに映っているか
export const screenPosOf = (page: Page, i: number) => page.evaluate(i => {
  const w = window as Win;
  const b = w.boxes[i];
  w.camera.updateMatrixWorld();
  const v = new w.THREE.Vector3(b.x, b.py + b.h / 2, b.z).project(w.camera);
  const r = w.gl.canvas.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
}, i);

// ビューポートの左上の、何もない所 (空)
export async function emptySpot(page: Page) {
  const r = (await page.locator('canvas#c').boundingBox())!;
  return { x: r.x + 80, y: r.y + r.height * 0.25 };
}

// テスト用の PMX モデルを、ファイル > MMD を読み込む… と同じ入力欄から読み込む
export async function loadTestModel(page: Page, extra: { name: string; mimeType: string; buffer: Buffer }[] = []) {
  await page.locator('input[type=file][multiple]').setInputFiles([
    { name: 'テスト人形.pmx', mimeType: 'application/octet-stream', buffer: Buffer.from(makePmx()) },
    ...extra,
  ]);
  await expect.poll(async () => (await uiState(page)).sel?.name).toBe('テスト人形');
}
