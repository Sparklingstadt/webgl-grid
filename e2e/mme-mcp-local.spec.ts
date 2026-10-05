import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makePmx } from './fixtures/pmx';
import { expect, test } from './fixtures/test';
import { FX_ROOT, HAS_RAY, RAY_FOLDER, RAY_OUT, RAY_ROOT, RAY_SKIP, SKY, pngStats, problems, threeParts, unsupported } from './ray-mmd-helpers';

// 手元だけの e2e: MCP のコマンドだけで、本物の Ray-MMD 1.5.2 (fx/ray-mmd-1.5.2/) の構成を組んで書き出す。
// MCP サーバーを起動し (fx/ の一覧は、そのサーバーが配るアプリが渡すふだんの fx/)、そのアプリのページをつないで、
// mme_list_fx・mme_load_folder → load_files (テスト用のモデル・ライト・フォグ・空のステージ) → mme_add_accessory (ray.x に ray.fx) →
// mme_assign (モデルの Main・MaterialMap、ステージの Main・EnvLightMap・FogMap・MaterialMap) → mme_add_controller → render_image。
// 「未対応」の警告とリンクの失敗が 0 で、PNG が真っ黒でない (空の領域が青い) ことを確かめ、PNG を test-results/ray-mmd/ に保存する。
// fx/ray-mmd-1.5.2/ray.fx がなければ (CI など) 飛ばす

type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
const W = 1280, H = 720;

test.skip(!HAS_RAY, RAY_SKIP);

test('MCP のコマンドだけで Ray-MMD の構成 (アクセサリ ray.x・コントローラー ray_controller.pmx・ステージの空) を組んで書き出す: 未対応の警告とリンクの失敗が 0 で、空が青い', async ({ page }, info) => {
  test.setTimeout(600_000);
  // 並列に動くテストとぶつからないよう、ワーカーごとにポートを変える (e2e/mcp.spec.ts とも重ならない番号)
  const wsPort = 17857 + info.workerIndex * 2, appPort = wsPort + 1;
  const dir = await mkdtemp(path.join(tmpdir(), 'webgl-grid-mcp-ray-'));
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StdioClientTransport({
    command: 'node', args: ['mcp/server.ts'], cwd: process.cwd(), stderr: 'ignore',
    env: { ...process.env, WEBGL_GRID_MCP_PORT: String(wsPort), WEBGL_GRID_APP_PORT: String(appPort), WEBGL_GRID_FX_DIR: FX_ROOT } as Record<string, string>,
  }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 }) as ToolResult;
    const t = r.content.find(c => c.type === 'text') as { text: string } | undefined;
    expect(r.isError, `${name}: ${t?.text.slice(0, 300)}`).toBeFalsy();
    return r;
  };
  const json = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await call(name, args)).content.find(c => c.type === 'text') as { text: string }).text);
  try {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    // (MCP サーバーが配るアプリ (dist/。e2e のサーバーがビルドしたもの) を開く: fx/ の一覧はそのサーバーが答える)
    await page.goto(`http://127.0.0.1:${appPort}/?debug&nomodels&mcp=${wsPort}`);
    await expect(page.getByLabel('MCP の接続')).toHaveText('MCP 接続中', { timeout: 30_000 });

    await json('mme_set', { settings: { engine: 'mme' } });
    await json('set_output', { width: W, height: H });

    // 1. fx/ の一覧から Ray-MMD のフォルダを読み込む
    const listed = (await json('mme_list_fx')).folders.find((f: { name: string }) => f.name === RAY_FOLDER);
    expect(listed).toMatchObject({ loaded: false });
    expect(listed.fx).toContain('ray.fx');
    const loaded = await json('mme_load_folder', { folder: RAY_FOLDER });
    expect(loaded.folder.name).toBe(RAY_FOLDER);

    // 2. モデル: テスト用のモデル (材質 3 つ)・点光源とスポットライト (色はモーフ)・グラウンドフォグ・空 (大きいのでステージになる)
    const dollPath = path.join(dir, 'テスト人形.pmx');
    writeFileSync(dollPath, makePmx('テスト人形', { outward: true, flags: 0x01 | 0x02 | 0x04 | 0x08, parts: threeParts() }));
    const doll = (await json('load_files', { paths: [dollPath] })).added[0];
    expect(doll).toEqual(expect.any(Number));
    const place = async (rel: string, x: number, z: number, morphs: Record<string, number> = {}) => {
      const [id] = (await json('load_files', { paths: [path.join(RAY_ROOT, rel)] })).added;
      expect(id, rel).toEqual(expect.any(Number));
      await json('set_object', { id, x, z });
      for (const [name, value] of Object.entries(morphs)) await json('set_morph', { id, name, value });
      return id;
    };
    await place('Lighting/PointLight.pmx', 0.6, 0.5, { 'R+': 1, 'G+': 0.6, 'B+': 0.3 });
    await place('Lighting/SpotLight.pmx', -0.6, 0.5, { 'R+': 0.3, 'G+': 0.6, 'B+': 1 });
    await place('Fog/GroundFog.pmx', -3, 1);
    expect((await json('load_files', { paths: [path.join(RAY_ROOT, SKY)] })).added).toEqual([]); // (ステージ)

    // 3. アクセサリ ray.x に ray.fx (ポストエフェクト)。ray.fx を描くと、オフスクリーンのタブ (MaterialMap など) ができる
    const acc = await json('mme_add_accessory', { name: 'ray.x', fx: { folder: RAY_FOLDER, path: 'ray.fx' } });
    expect(acc).toMatchObject({ name: 'ray.x', kind: 'accessory', fx: { folderName: RAY_FOLDER, path: 'ray.fx' } });
    await expect.poll(async () => (await json('mme_state')).tabs.map((t: { name: string }) => t.name), { timeout: 60_000 })
      .toEqual(expect.arrayContaining(['Main', 'MaterialMap', 'EnvLightMap', 'FogMap']));

    // 4. 割り当て: モデルの Main と、材質ごとの MaterialMap (肌・髪・material_2.0)。ステージ (空) の Main・EnvLightMap・FogMap・MaterialMap
    const fx = (p: string) => ({ folder: RAY_FOLDER, path: p });
    await json('mme_assign', { object: doll, tab: 'Main', fx: fx('Main/main.fx') });
    await json('mme_assign', { object: doll, tab: 'MaterialMap', material: 0, fx: fx('Materials/Skin/material_skin.fx') });
    await json('mme_assign', { object: doll, tab: 'MaterialMap', material: 1, fx: fx('Materials/Hair/material_hair.fx') });
    await json('mme_assign', { object: doll, tab: 'MaterialMap', material: 2, fx: fx('Materials/material_2.0.fx') });
    await json('mme_assign', { object: 'stage', tab: 'Main', fx: fx('Skybox/Time of day/Time of day.fx') });
    await json('mme_assign', { object: 'stage', tab: 'EnvLightMap', fx: fx('Skybox/Time of day/Time of lighting.fx') });
    await json('mme_assign', { object: 'stage', tab: 'FogMap', fx: fx('Skybox/Time of day/Time of fog.fx') });
    await json('mme_assign', { object: 'stage', tab: 'MaterialMap', fx: fx('Materials/material_skybox.fx') });

    // 5. コントローラー ray_controller.pmx (ray.fx が読む名前)
    const ctl = await json('mme_add_controller', { name: 'ray_controller.pmx' });
    const state = await json('mme_state');
    expect(state.controllers.find((c: { name: string }) => c.name === 'ray_controller.pmx')).toMatchObject({ id: ctl.id });
    expect(state.accessories).toEqual([expect.objectContaining({ id: acc.id, name: 'ray.x', enabled: true, ok: true })]);
    expect(state.assignments).toEqual(expect.arrayContaining([
      { object: 'stage', tab: 'Main', material: null, fx: { folder: loaded.folder.id, folderName: RAY_FOLDER, path: 'Skybox/Time of day/Time of day.fx' } },
      { object: doll, tab: 'MaterialMap', material: 0, fx: { folder: loaded.folder.id, folderName: RAY_FOLDER, path: 'Materials/Skin/material_skin.fx' } },
    ]));

    // 6. 視点 (e2e/ray-mmd-local.spec.ts と同じ) から書き出す。2 回書き出す (1 回目でオフスクリーンのタブ・画像の読み込みがそろう)
    await json('set_camera', { yawDeg: (Math.PI / 2 + 0.35) * 180 / Math.PI, pitchDeg: 0.12 * 180 / Math.PI, distance: 7, target: [0, 0.8, -0.6] });
    await call('render_image');
    mkdirSync(RAY_OUT, { recursive: true });
    const file = path.join(RAY_OUT, 'ray-mmd-mcp.png');
    const rendered = await call('render_image', { path: file });
    const image = rendered.content.find(c => c.type === 'image') as { data: string };
    const stats = await pngStats(page, image.data, [[0.25, 0.05], [0.5, 0.05], [0.75, 0.05]]);
    const after = await json('mme_state');
    const p = await problems(page);
    if (process.env.RAY_MMD_LOG) console.log(JSON.stringify({ state: after.warnings, ...p }, null, 2));
    console.log(`PNG: ${file} (平均の明るさ ${stats.mean.toFixed(3)})、空: ${stats.image.map(c => `${c.mean.toFixed(3)} (赤・青 ${c.r.toFixed(2)}・${c.b.toFixed(2)})`).join(', ')}`);

    expect([stats.width, stats.height]).toEqual([W, H]);
    expect(unsupported([...after.warnings, ...p.warnings, ...p.compile])).toEqual([]);
    expect(after.accessories[0]).toMatchObject({ ok: true });
    expect(p.failed).toEqual([]);
    expect(p.stopped).toEqual([]);
    expect(p.drawn).toEqual(expect.arrayContaining([`${RAY_FOLDER}/ray.fx`, `${RAY_FOLDER}/Main/main.fx`]));
    expect(errors).toEqual([]);
    expect(stats.mean, '絵の平均').toBeGreaterThan(0.05);
    expect(Math.min(...stats.image.map(c => c.mean)), '空が見える (上の端が黒くない)').toBeGreaterThan(0.05);
    expect(stats.image.filter(c => c.b > c.r).length, `空が青みがかる (青 > 赤): ${JSON.stringify(stats.image)}`).toBe(stats.image.length);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
