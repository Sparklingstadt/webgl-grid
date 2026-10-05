import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listFx } from './fx.ts';

// fx/ の一覧の上限は、フォルダごと (小さな上限で確かめる)
let dir = '';
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'webgl-grid-fx-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function put(rel: string[]) {
  for (const r of rel) {
    await mkdir(path.dirname(path.join(dir, r)), { recursive: true });
    await writeFile(path.join(dir, r), 'x');
  }
}
const many = (folder: string, n: number) => Array.from({ length: n }, (_, i) => `${folder}/f${i}.fx`);
const limits = (maxFiles: number, maxDepth = 8) => ({ maxFiles, maxDepth });

describe('fx/ の一覧 (サーバー)', () => {
  it('上限を超えたフォルダだけ一部の一覧 (truncated) になり、ほかのフォルダは全部出る (上限は共有しない)', async () => {
    await put([...many('A', 6), ...many('B', 6), ...many('C', 3)]);
    const { folders } = await listFx(dir, limits(5));
    expect(folders.map(f => [f.name, f.files.length, f.truncated ?? false])).toEqual([['A', 5, true], ['B', 5, true], ['C', 3, false]]);
  });
  it('ちょうど上限のフォルダは、一部ではない', async () => {
    await put(many('A', 5));
    expect((await listFx(dir, limits(5))).folders.map(f => [f.files.length, f.truncated ?? false])).toEqual([[5, false]]);
  });
  it('深すぎるフォルダの中は見ず、見残したので truncated', async () => {
    await put(['A/a.fx', 'A/b/c/deep.fx', 'B/b.fx']);
    const { folders } = await listFx(dir, limits(100, 1));
    expect(folders.map(f => [f.name, f.files, f.truncated ?? false])).toEqual([['A', ['a.fx'], true], ['B', ['b.fx'], false]]);
  });
  it('直下のファイルも、上限を超えれば truncated で、フォルダの上限とは別', async () => {
    await put([...many('A', 2), 'l0.fx', 'l1.fx', 'l2.fx']);
    const { folders } = await listFx(dir, limits(2));
    expect(folders.map(f => [f.name, f.files.length, f.truncated ?? false])).toEqual([['A', 2, false], ['fx', 2, true]]);
  });
});
