import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/test';
import { makePmx } from './fixtures/pmx';
import { makeVmd } from './fixtures/vmd';
import type { Win } from './helpers';

// 外部からの操作 (MCP): MCP サーバーを起動し、?mcp でつないだページをツールで操作する
type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };

test('MCP のツールで、形を置き・モデルを読み込み・キーフレームを打ち・レンダリングして保存する', async ({ page }, info) => {
  test.setTimeout(90_000);
  // 並列に動くテストとぶつからないよう、ワーカーごとにポートを変える
  const wsPort = 17457 + info.workerIndex * 2, appPort = wsPort + 1;
  const dir = await mkdtemp(path.join(tmpdir(), 'webgl-grid-mcp-'));
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StdioClientTransport({
    command: 'node', args: ['mcp/server.ts'], cwd: process.cwd(), stderr: 'ignore',
    env: { ...process.env, WEBGL_GRID_MCP_PORT: String(wsPort), WEBGL_GRID_APP_PORT: String(appPort) } as Record<string, string>,
  }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as ToolResult;
    expect(r.isError, `${name}: ${JSON.stringify(r.content).slice(0, 300)}`).toBeFalsy();
    return r;
  };
  const json = async (name: string, args: Record<string, unknown> = {}) => {
    const t = (await call(name, args)).content.find(c => c.type === 'text');
    return JSON.parse((t as { text: string }).text);
  };
  try {
    // ページがつながっていないときは、分かるエラーを返す
    const off = await client.callTool({ name: 'get_state', arguments: {} }) as ToolResult;
    expect(off.isError).toBe(true);

    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`/?debug&nomodels&mcp=${wsPort}`);
    await expect(page.getByLabel('MCP の接続')).toHaveText('MCP 接続中');
    expect((await json('app_status')).connected).toBe(true);

    // 形 (何もない場面に、原点の立方体と、トーラス)
    expect((await json('get_state')).objects).toEqual([]);
    await json('add_shape', { shape: 'cube', x: 0, z: 0 });
    const { id } = await json('add_shape', { shape: 'torus', x: 3, z: -1, color: '赤' });
    let state = await json('get_state');
    expect(state.objects.find((o: { id: number }) => o.id === id)).toMatchObject({ name: 'トーラス', position: [3, 0, -1], color: '赤' });
    await json('set_object', { id, x: 0, z: 0 }); // 立方体の上に積まれる
    state = await json('get_state');
    expect(state.objects.find((o: { id: number }) => o.id === id).position[1]).toBeGreaterThan(0);

    // ファイル: .pmx (と .vmd) を手元のパスから読み込む
    await writeFile(path.join(dir, 'テスト人形.pmx'), makePmx('テスト人形'));
    await writeFile(path.join(dir, 'テスト.vmd'), makeVmd([{ bone: 'センター', frame: 0, pos: [0, 0, 0] }, { bone: 'センター', frame: 20, pos: [0, 0, 3] }]));
    const loaded = await json('load_files', { paths: [path.join(dir, 'テスト人形.pmx'), path.join(dir, 'テスト.vmd')] });
    expect(loaded.added).toHaveLength(1);
    const model = loaded.added[0];

    // ボーン・表情・キーフレーム・タイムライン
    await json('timeline', { playing: false, frame: 0 });
    expect((await json('list_bones', { id: model })).flatMap((g: { bones: string[] }) => g.bones)).toContain('右腕');
    expect((await json('set_bone', { id: model, bone: '右腕', rotationDeg: [0, 0, 30] })).value.rz).toBe(30);
    expect((await json('set_morph', { id: model, name: 'まばたき', value: 0.5 })).value).toBeCloseTo(0.5);
    expect((await json('insert_keyframe', { id: model, frame: 10 })).keyframes).toEqual([10]);
    expect(await page.evaluate(() => (window as Win).engine.clock.frame)).toBe(10);

    // マテリアル
    const mats = await json('list_materials');
    const mat = mats.find((m: { users: number }) => m.users > 0);
    await json('set_material', { material: mat.name, inputs: { baseColor: '#ff0000', roughness: 0.25 } });
    const after = (await json('list_materials')).find((m: { id: string }) => m.id === mat.id);
    expect(after.inputs).toMatchObject({ baseColor: '#ff0000', roughness: 0.25 });

    // 見た目: スクリーンショットとレンダリング (PNG を返し、保存もする)
    const shot = await call('screenshot', { maxSize: 256 });
    expect(shot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    await json('set_output', { width: 160, height: 90 });
    const png = path.join(dir, 'out', 'frame.png');
    const rendered = await call('render_image', { path: png });
    expect(rendered.content[0].type).toBe('image');
    const bytes = await readFile(png);
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([160, 90]);

    // プロジェクトの保存と、開き直し
    const wgp = path.join(dir, 'シーン.wgp');
    expect((await json('save_project', { path: wgp })).bytes).toBeGreaterThan(1000);
    await json('reset_scene');
    expect((await json('get_state')).objects).toEqual([]); // (何もない場面に戻る)
    const reopened = await json('open_project', { path: wgp });
    expect(reopened.project).toBe('シーン');
    expect(reopened.objects.map((o: { kind: string }) => o.kind)).toEqual(['shape', 'shape', 'model']);
    expect(reopened.objects[2].keyframes).toEqual([10]);

    // 参照だけのプロジェクト (.wgpj): MCP で読んだファイルは元の場所を覚えていて、開くときに自動で読み込む
    const ref = path.join(dir, 'プロジェクト', '参照.wgpj');
    await json('save_project', { path: ref });
    const saved = JSON.parse(await readFile(ref, 'utf8'));
    expect(saved.assets.map((a: { name: string; relative: string }) => [a.name, a.relative])).toEqual([
      ['テスト人形.pmx', path.join('..', 'テスト人形.pmx')], ['テスト.vmd', path.join('..', 'テスト.vmd')],
    ]);
    await json('reset_scene');
    await page.reload(); // 読んだファイルを覚えていない、まっさらなページ
    await expect(page.getByLabel('MCP の接続')).toHaveText('MCP 接続中');
    const refOpened = await json('open_project', { path: ref });
    expect(refOpened.missing).toEqual([]);
    expect(refOpened.objects.map((o: { kind: string }) => o.kind)).toEqual(['shape', 'shape', 'model']);
    expect(refOpened.objects[2].keyframes).toEqual([10]);
    expect(errors).toEqual([]);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('MCP サーバーを待っているあいだはエラーを出さず、あとから起動するとつながる', async ({ page }, info) => {
  test.setTimeout(60_000);
  const wsPort = 17557 + info.workerIndex * 2, appPort = wsPort + 1;
  const messages: string[] = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') messages.push(m.text()); });
  page.on('pageerror', e => messages.push(String(e)));
  await page.goto(`/?debug&nomodels&mcp=${wsPort}`);
  await expect(page.getByLabel('MCP の接続')).toHaveText('MCP 待機中');
  await page.waitForTimeout(1500); // 1 回つなぎ直すあいだ
  expect(messages).toEqual([]);

  // 3 回つなぎ直すあいだ (1・2・4 秒) に起動すれば、つながる
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StdioClientTransport({
    command: 'node', args: ['mcp/server.ts'], cwd: process.cwd(), stderr: 'ignore',
    env: { ...process.env, WEBGL_GRID_MCP_PORT: String(wsPort), WEBGL_GRID_APP_PORT: String(appPort) } as Record<string, string>,
  }));
  try {
    await expect(page.getByLabel('MCP の接続')).toHaveText('MCP 接続中', { timeout: 10_000 });
    const r = await client.callTool({ name: 'app_status', arguments: {} }) as ToolResult;
    expect(JSON.parse((r.content[0] as { text: string }).text).connected).toBe(true);
  } finally {
    await client.close();
  }
  // サーバーが止まっても、待っているあいだはエラーを出さない
  await expect(page.getByLabel('MCP の接続')).toHaveText('MCP 待機中');
  await page.waitForTimeout(1500);
  expect(messages).toEqual([]);
});
