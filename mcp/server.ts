#!/usr/bin/env node
// --- webgl-grid の MCP サーバー ---
// Claude などの MCP クライアントから、ブラウザで開いている webgl-grid を操作する。
//   クライアント ⇄ (stdio) ⇄ この MCP サーバー ⇄ (WebSocket, 127.0.0.1) ⇄ ページ (?mcp を付けて開いたもの)
// ファイルの読み書き (モデルの読み込み・レンダリングの保存・プロジェクト) は、このサーバーが手元のパスで行う。
//   npm run mcp で起動。環境変数 WEBGL_GRID_MCP_PORT (WebSocket、既定 7457)・WEBGL_GRID_APP_PORT (アプリを配る、既定 7458)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { REMOTE_DEFAULT_PORT } from '../src/core/remote.ts';
import { openBrowser, serveApp } from './appServer.ts';
import { AppBridge, NOT_CONNECTED } from './bridge.ts';
import { readFile } from 'node:fs/promises';
import { collectFiles, findAsset, readAsRemoteFiles, writeBase64 } from './files.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CWD = process.cwd();
const WS_PORT = Number(process.env.WEBGL_GRID_MCP_PORT) || REMOTE_DEFAULT_PORT;
const APP_PORT = Number(process.env.WEBGL_GRID_APP_PORT) || REMOTE_DEFAULT_PORT + 1;
const log = (msg: string) => process.stderr.write(`[webgl-grid-mcp] ${msg}\n`); // stdout は MCP の通信に使う

const bridge = new AppBridge(WS_PORT, log);
await bridge.ready.catch(err => { log(`ポート ${WS_PORT} で待てません: ${err.message}`); process.exit(1); });
const appServer = await serveApp(path.join(ROOT, 'dist'), APP_PORT).catch(err => { log(`アプリを配れません: ${err.message}`); return null; });
const appUrl = appServer ? `http://localhost:${APP_PORT}/?mcp=${WS_PORT}` : null;
log(`WebSocket 127.0.0.1:${WS_PORT} で待っています${appUrl ? `。アプリ: ${appUrl}` : ' (dist/ がないので、アプリは npm run dev などで開いてください)'}`);

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };
const text = (v: unknown): Content => ({ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) });

// ページに命令を送る。つながっていなければ少し待つ (再読み込み中など)
async function call(method: string, params: unknown = {}, timeoutMs = 60_000) {
  if (!bridge.connected && !(await bridge.waitForApp(3000))) throw new Error(NOT_CONNECTED);
  return await bridge.call(method, params, timeoutMs) as Record<string, unknown>;
}

const server = new McpServer({ name: 'webgl-grid', version: '1.0.0' }, {
  instructions: 'ブラウザで動く MMD ビューアー・エディター webgl-grid を操作する。まず app_status でページがつながっているか確かめ、つながっていなければ open_app で開く。'
    + '場面は get_state で、見た目は screenshot で確かめられる。長さの単位はこのアプリの単位 (MMD モデルの身長がおよそ 1.6)、角度は度、フレームは 30 fps。',
});
// 失敗はツールのエラーとして返す (クライアントが読んで直せるように)
function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (a: z.infer<z.ZodObject<S>>) => Promise<Result>) {
  server.registerTool(name, { description, inputSchema: shape }, (async (a: z.infer<z.ZodObject<S>>) => {
    try { return await run(a); } catch (err) { return { content: [text(`エラー: ${(err as Error).message}`)], isError: true }; }
  }) as never);
}
// 引数をそのままページに渡して、結果を JSON で返すツール
const forward = <S extends z.ZodRawShape>(name: string, description: string, shape: S, timeoutMs?: number) =>
  tool(name, description, shape, async a => ({ content: [text(await call(name, a, timeoutMs))] }));

// アドオンの命令を、専用のツールとして出す (アドオンが切ってあればエラー。set_addon で有効にする)
const forwardAddon = <S extends z.ZodRawShape>(name: string, command: string, description: string, shape: S) =>
  tool(name, `${description} (${command.split('.')[0]} アドオンの命令)`, shape, async a => ({ content: [text(await call('run_command', { name: command, params: a }))] }));

const id = z.number().int().optional().describe('物の id (get_state の objects[].id)。省くと選んでいる物 (モデルの操作では最初のモデル)');
const frame = z.number().int().min(0).optional();

tool('app_status', 'ページがつながっているかと、アプリの URL', {}, async () => ({
  content: [text({ connected: bridge.connected, page: bridge.appUrl, appUrl, websocketPort: WS_PORT })],
}));
tool('open_app', 'いつものブラウザでアプリを開き、つながるまで待つ (このサーバーが dist/ を配る。先に npm run build が必要)', {}, async () => {
  if (bridge.connected) return { content: [text(`もうつながっています: ${bridge.appUrl}`)] };
  if (!appUrl) throw new Error('dist/ がありません。リポジトリで npm run build を実行するか、npm run dev で開いたページの URL に ?mcp を付けて開いてください');
  openBrowser(appUrl);
  const ok = await bridge.waitForApp(30_000);
  return { content: [text(ok ? `開きました: ${bridge.appUrl}` : `${appUrl} を開きましたが、30 秒たってもつながりません`)], isError: !ok };
});

forward('get_state', '場面の様子 (物の一覧と id・位置・マテリアル、タイムライン、視点、効果、出力の設定)', {});
tool('screenshot', 'いまのビューポートの見た目 (グリッドや選択の輪郭線も込み) を画像で見る', { maxSize: z.number().int().min(64).max(4096).optional().describe('長い辺の最大ピクセル (既定 1024)') }, async a => {
  const r = await call('screenshot', a);
  return { content: [{ type: 'image', data: String(r.png), mimeType: 'image/png' }, text(`${r.width}×${r.height}`)] };
});

// 物
forward('add_shape', '形を置いて選ぶ。x, z を省くと画面の中央付近の空いている所', {
  shape: z.enum(['cube', 'sphere', 'cylinder', 'cone', 'capsule', 'torus', 'tube', 'disc', 'plane', 'pyramid', 'icosahedron']).optional(), x: z.number().optional(), z: z.number().optional(),
  color: z.union([z.number().int().min(0).max(7), z.string()]).optional().describe('0〜7 か色の名前 (黄土・赤・青緑・青・紫・緑・ピンク・灰)'),
});
forward('select', '物を選ぶ (id を省くと選択を解除。ids で いくつかをまとめて選び、最後の物がアクティブ)', { id, ids: z.array(z.number().int()).optional() });
forward('set_object', '物の位置・向き・色・名前・表示を変える (重なる位置なら上に積まれる)', {
  id, x: z.number().optional(), z: z.number().optional(), rotationDeg: z.number().optional().describe('縦軸まわりの回転 (度)'),
  color: z.union([z.number().int().min(0).max(7), z.string()]).optional(),
  scale: z.number().positive().optional().describe('大きさ (拡大率 0.05〜20。形だけ)'),
  name: z.string().nullable().optional().describe('名前 (空・null で種類の名前に戻す)'),
  hidden: z.boolean().optional().describe('ビューポートで隠す (Blender の目のアイコン。レンダリングには写る)'),
  hideRender: z.boolean().optional().describe('レンダリングに写さない (Blender のカメラのアイコン)'),
});
forward('delete_object', '物を消す', { id });
forward('duplicate_object', '物を複製する (Blender の Shift+D。隣に置き、マテリアルは共有、名前に .001 などの番号。MMD モデルはポーズ・キーフレーム・モーションも写す)', { id });
forward('reorder_objects', '物の並び (アウトライナーの順) を変える。ids の順に先頭から並べ、書いていない物はその後ろに元の順で', { ids: z.array(z.number().int()) });
const vec3 = z.array(z.number()).length(3);
const paramRecord = z.record(z.string(), z.union([z.number(), z.boolean(), z.string()]));
const effectorList = z.array(z.object({
  kind: z.string().describe('plain・step・random・formula・time・target・delay・shader・pushapart・volume・inheritance・sound (MoGraph エフェクタのアドオン)'),
  enabled: z.boolean().optional(), position: vec3.optional(), rotationDeg: z.number().optional(), scale: z.number().positive().optional(),
  params: paramRecord.optional().describe('種類ごとの設定: random { seed }・formula { expression (Cinema 4D と同じ式。t・f・w・id・count・x y z・rnd。三角関数は度), frequency, waves }・'
    + 'target { x, z }・delay { frames }・shader { size, speed, seed }・pushapart { radius, iterations }・volume { target: 物の id }・inheritance { target: クローナーの id }・sound { mode: bands / all, gain }'),
  select: z.string().optional().describe('MoGraph 選択: 効くクローンの番号 ("0-4, 7"・"偶数"・"奇数"。空なら全部)'),
  fields: z.array(z.object({
    kind: z.string().describe('linear・sphere・box・cylinder・radial・random・noise・time (MoGraph フィールドのアドオン)'),
    enabled: z.boolean().optional(), blend: z.enum(['normal', 'max', 'min', 'add', 'subtract', 'multiply']).optional(),
    opacity: z.number().min(0).max(1).optional(), invert: z.boolean().optional(),
    params: paramRecord.optional().describe('場所を持つものは cx・cy・cz (中心)。sphere { radius, inner }・box { sx, sy, sz, inner }・cylinder { radius, height, inner }・linear { axis, length }・radial { turns }・noise { size, speed, contrast, seed }・time { start, length }・random { seed }'),
  })).optional().describe('フィールド (効く範囲。上から重ねる。なければ全体に効く)'),
})).optional().describe('エフェクタ (上から順にかける。渡すと並びごと入れ替える)。位置・回転・大きさを、強さ (フィールドと MoGraph 選択も) に合わせて足す');
forwardAddon('set_cloner', 'cinema4d.set_cloner', 'クローナー (Cinema 4D のクローナー): 物を並べる。元の物の位置と向きが中心。MMD モデルは全部が同じ動きで踊る。省いた設定は今のまま。off: true でやめる', {
  id, off: z.boolean().optional(),
  mode: z.string().optional().describe('linear・radial・grid と、MoGraph 配置のアドオンの honeycomb (ハニカム)・object (ほかの物の頂点・面・表面・中身)'),
  modeParams: paramRecord.optional().describe('honeycomb { width, height, spacing, plane: xz / xy }・object { target: 物の id, distribution: vertices / faces / surface / volume, count, seed, align }'),
  count: z.number().int().min(1).optional().describe('直線・放射の数'),
  step: vec3.optional().describe('直線: 1 つごとのずれ [x, y, z]'), stepRotDeg: z.number().optional().describe('直線: 1 つごとの回転 (度)'),
  radius: z.number().min(0).optional(), startDeg: z.number().optional(), endDeg: z.number().optional(), align: z.boolean().optional().describe('放射: 外を向く'),
  grid: vec3.optional().describe('グリッドの数 [x, y, z]'), spacing: vec3.optional().describe('グリッドの間隔 [x, y, z]'),
  random: z.object({ position: z.number().min(0).optional(), rotationDeg: z.number().min(0).optional(), seed: z.number().int().optional() }).optional().describe('ばらつき'),
  effectors: effectorList,
});
forwardAddon('set_motext', 'mograph-text.set', 'MoText (Cinema 4D の MoText): 厚みのある文字を立てて置き、文字・単語・行ごとにエフェクタで動かす。id を省くと新しく置く。省いた設定は今のまま。off: true でやめる', {
  id, off: z.boolean().optional(), text: z.string().optional().describe('文字 (\\n で改行。日本語も)'),
  font: z.string().optional().describe('sans-serif (ゴシック)・serif (明朝)・monospace・cursive か、フォントの名前'), weight: z.enum(['normal', 'bold']).optional(),
  size: z.number().positive().optional(), depth: z.number().positive().optional().describe('厚み'), bevel: z.number().min(0).max(0.5).optional().describe('面取り'),
  spacing: z.number().optional().describe('字間'), lineSpacing: z.number().positive().optional(), align: z.enum(['left', 'center', 'right']).optional(),
  unit: z.enum(['letters', 'words', 'lines', 'all']).optional().describe('エフェクタをかける単位'), effectors: effectorList,
});
forwardAddon('set_fracture', 'mograph-fracture.set', '分割 (Cinema 4D のボロノイ分割・PolyFX): 形を破片に分け、エフェクタで動かす。省いた設定は今のまま。off: true でやめる', {
  id, off: z.boolean().optional(), mode: z.enum(['voronoi', 'polyfx']).optional(), count: z.number().int().min(1).optional().describe('破片の数'),
  seed: z.number().int().optional(), spread: z.enum(['uniform', 'center', 'edge']).optional(), gap: z.number().min(0).max(0.9).optional(), effectors: effectorList,
});
const hexColor = z.string().regex(/^#?[0-9a-fA-F]{6}$/).describe('"#rrggbb"');
const lightType = z.enum(['point', 'sun', 'spot', 'area']).describe('Blender のライトの種類: ポイント・サン・スポット・エリア');
const lightSettings = {
  color: hexColor.optional(),
  power: z.number().min(0).optional().describe('ポイント・スポット・エリア: パワー (W。Blender と同じ。ポイント 400・スポット 1000・エリア 20 くらい)'),
  strength: z.number().min(0).optional().describe('サン: 強さ (W/m²。3 くらい)'),
  radius: z.number().min(0).optional().describe('ポイント・スポット: 半径 (m。影のぼけ)'), angleDeg: z.number().min(0).max(180).optional().describe('サン: 角度 (度。影のぼけ)'),
  spotSizeDeg: z.number().min(1).max(180).optional().describe('スポット: スポットサイズ (円すい全体の角度)'), blend: z.number().min(0).max(1).optional().describe('スポット: ブレンド (縁のぼけ)'),
  shape: z.enum(['square', 'rectangle']).optional().describe('エリア: 形状'), size: z.number().positive().optional().describe('エリア: サイズ (長方形では X)'), sizeY: z.number().positive().optional().describe('エリア: サイズ Y (長方形)'),
  height: z.number().positive().optional().describe('床からの高さ'), tiltDeg: z.number().optional().describe('サン・スポット・エリア: 真下からの傾き (物の向きの前へ)'),
  range: z.number().min(0).optional().describe('ポイント・スポット: カスタム距離 (0 で果てしなく)'), shadows: z.boolean().optional().describe('影 (エリアは落とせない)'),
};
forward('add_light', 'ライト (Blender のライト) を置いて選ぶ。向きは set_object の rotationDeg', { type: lightType.optional(), x: z.number().optional(), z: z.number().optional(), ...lightSettings });
forward('set_light', 'ライトの設定を変える (渡したところだけ)', { id, type: lightType.optional(), ...lightSettings });
forward('list_addons', 'アドオン (Blender のアドオン) の一覧と、有効かどうか', {});
forward('set_addon', 'アドオンを有効にする・切る (有効にしたものは、次に開いたときも有効)', { id: z.string().describe('アドオンの id (list_addons)'), enabled: z.boolean() });
forward('list_commands', '有効なアドオンが足した命令の一覧 (名前・説明・引数)。run_command で使う', {});
forward('run_command', 'アドオンが足した命令を実行する', {
  name: z.string().describe('命令の名前 ("アドオンの id.命令"。list_commands で確かめる)'),
  params: z.record(z.string(), z.unknown()).optional().describe('引数 (list_commands の params)'),
});
forwardAddon('set_deformers', 'cinema4d.set_deformers', 'デフォーマ (Cinema 4D のデフォーマ): 物を曲げる・ねじる・細くする・ふくらませる。上から順にかける。並びごと入れ替える (空でやめる)。MMD モデルはボーンで動かす前の形にかける', {
  id, deformers: z.array(z.object({
    kind: z.enum(['bend', 'twist', 'taper', 'bulge']), enabled: z.boolean().optional(), axis: z.enum(['x', 'y', 'z']).optional(),
    amount: z.number().optional().describe('ベンド・ツイスト: 角度 (度)、テーパー・バルジ: 強さ (0 でそのまま。テーパー -0.5 で上が半分)'),
    directionDeg: z.number().optional().describe('ベンド: 曲げる向き (度)'),
  })),
});
forwardAddon('bake_cloner', 'cinema4d.bake_cloner', '形のクローナーのクローンを、1 つずつの物にする (Cinema 4D の「現在の状態をオブジェクト化」)', { id });
forward('reset_scene', '最初の状態 (何も置いていない場面) に戻す', {});

// ファイル
tool('load_files', 'MMD のファイルを読み込む: .pmx (同じフォルダのテクスチャ画像も自動で送る)・.vmd (ダンス・カメラ)・.vpd (ポーズ)・曲 (.wav/.mp3 など)。フォルダを渡すと中のファイルをすべて送る', {
  paths: z.array(z.string()).min(1).describe('手元のファイル・フォルダのパス (絶対パスがおすすめ)'),
}, async a => {
  const list = await collectFiles(a.paths, CWD);
  const { files, bytes } = await readAsRemoteFiles(list);
  const r = await call('load_files', { files }, 300_000);
  return { content: [text({ sent: files.length, megabytes: +(bytes / 1048576).toFixed(1), message: r.message, added: r.added }), text(r.state)] };
});

// タイムライン・キーフレーム
forward('timeline', 'タイムライン: いまのフレームへ飛ぶ・範囲 (開始・終了) を変える・再生/停止', {
  frame, start: frame, end: frame, playing: z.boolean().optional(),
});
forward('insert_keyframe', 'いまの値をキーフレームにする: モデルはポーズと表情、形・ライトは位置・回転・大きさ (frame を渡すとそこへ飛んでから)', { id, frame });
forward('delete_keyframe', '物のキーフレームを消す (frame を渡すとそこへ飛んでから)', { id, frame });

// ポーズ・表情
forward('list_bones', 'モデルの動かせるボーンの名前 (表示枠ごと)', { id });
forward('set_bone', 'ボーンを動かす。回転は最初の姿勢からの角度 (度, X/Y/Z)、位置はずれ (MMD の単位)。省いた成分はそのまま', {
  id, bone: z.string().describe('ボーンの名前 (例: 右腕, センター)'),
  rotationDeg: z.array(z.number()).length(3).optional(), position: z.array(z.number()).length(3).optional(),
});
forward('reset_pose', '手で動かしたボーンを戻す', { id });
forward('list_morphs', 'モデルの表情 (モーフ) の名前といまの値', { id });
forward('set_morph', '表情 (モーフ) の値を 0〜1 で変える', { id, name: z.string(), value: z.number().min(0).max(1) });
forward('set_hair_hang', '髪の形を保つ錘を外して、髪を重力で垂らす (on: false で戻す)', { id, on: z.boolean() });

// 視点
forward('set_camera', '視点を変える (カメラモーションは止まる)。view で前・右・上・最初の視点へ', {
  view: z.enum(['front', 'right', 'top', 'home']).optional(), yawDeg: z.number().optional(), pitchDeg: z.number().optional(),
  distance: z.number().positive().optional(), target: z.array(z.number()).length(3).optional().describe('注視点 [x, y, z]'),
  fov: z.number().min(5).max(120).optional().describe('縦の画角 (度)'),
});

// マテリアル
forward('list_materials', 'マテリアルの一覧 (プリンシプル BSDF の入力の値・設定・輪郭線)', {});
forward('set_material', 'マテリアル (プリンシプル BSDF) の値を変える。色は "#rrggbb"', {
  material: z.string().optional().describe('マテリアルの名前か id'), id, slot: z.number().int().min(0).optional().describe('material を省いたとき、物 id のこのスロットのマテリアル'),
  inputs: z.record(z.string(), z.union([z.number(), z.string(), z.array(z.number())])).optional()
    .describe('例: {"baseColor": "#ff8080", "roughness": 0.3, "metallic": 0, "alpha": 1, "emissionColor": "#000000", "emissionStrength": 0}'),
  settings: z.object({ blend: z.enum(['opaque', 'blend', 'clip']).optional(), backfaceCulling: z.boolean().optional() }).optional(),
  outline: z.object({ enabled: z.boolean().optional(), color: z.array(z.number()).length(3).optional(), size: z.number().min(0).optional() }).optional(),
  name: z.string().optional().describe('名前を変える'),
});

// 効果・出力・レンダリング
forward('set_effect', 'MME 風の効果のオン・オフと強さ', {
  effect: z.enum(['ao', 'dof', 'bloom', 'diffusion', 'color']), enabled: z.boolean().optional(),
  levels: z.record(z.string(), z.number()).optional().describe('強さ: ao, dof, bloom, diffusion, temp, sat, bright'),
});
forward('set_scene', 'シーンの設定 (Cinema 4D の空・床・太陽): 背景の空、床、太陽の光、部屋の光 (環境光)。渡したところだけ変える', {
  sky: z.object({ mode: z.enum(['viewport', 'color', 'gradient']).optional(), top: hexColor.optional(), bottom: hexColor.optional() }).optional()
    .describe('viewport: ビューポートの灰色 / color: top の単色 / gradient: 地平線 (bottom) から真上 (top) へ'),
  floor: z.object({ enabled: z.boolean().optional(), color: hexColor.optional(), roughness: z.number().min(0).max(1).optional() }).optional(),
  sun: z.object({ intensity: z.number().min(0).max(10).optional(), color: hexColor.optional(), azimuthDeg: z.number().optional(),
    elevationDeg: z.number().min(1).max(90).optional(), shadows: z.boolean().optional() }).optional(),
  environment: z.number().min(0).max(5).optional().describe('部屋の光 (環境光) の明るさ'),
});
forward('set_output', 'レンダリングの出力の設定', {
  width: z.number().int().min(16).max(4096).optional(), height: z.number().int().min(16).max(4096).optional(),
  format: z.enum(['mp4', 'webm']).optional(), quality: z.enum(['medium', 'high', 'veryHigh']).optional(), audio: z.boolean().optional(),
});
tool('render_image', 'いまの視点から出力の解像度で 1 枚レンダリングする (グリッド・選択の輪郭線なし)。画像を返し、path があれば PNG を保存する', {
  frame, path: z.string().optional().describe('保存する .png のパス'),
}, async a => {
  const r = await call('render_image', { frame: a.frame }, 120_000);
  const saved = a.path ? await writeBase64(a.path, CWD, String(r.png)) : null;
  return { content: [{ type: 'image', data: String(r.png), mimeType: 'image/png' }, text({ width: r.width, height: r.height, frame: r.frame, saved })] };
});
tool('render_animation', 'タイムラインの開始〜終了フレームを動画 (MP4 / WebM) にして保存する。曲があれば入る', {
  path: z.string().describe('保存するパス (.mp4 か .webm。拡張子は出力の形式に合わせて直す)'),
}, async a => {
  const r = await call('render_animation', {}, 3_600_000);
  const target = a.path.replace(/\.(mp4|webm)$/i, '') + `.${r.ext}`;
  const saved = await writeBase64(target, CWD, String(r.data));
  return { content: [text({ ...saved, frames: r.frames, codec: r.codec })] };
});

// プロジェクト
tool('save_project', 'いまの場面をプロジェクトに保存する。.wgp はモデル・モーション・曲などのファイルも入れる。.wgpj (reference) はファイルを入れず、元のファイルの場所を参照するだけ (小さい)', {
  path: z.string().describe('保存するパス (.wgp か .wgpj)'),
  reference: z.boolean().optional().describe('ファイルは参照だけにする (省くと、path が .wgpj なら参照だけ)'),
}, async a => {
  const reference = a.reference ?? /\.wgpj$/i.test(a.path);
  const target = path.resolve(CWD, a.path.replace(/\.wgpj?$/i, '') + (reference ? '.wgpj' : '.wgp'));
  const r = await call('save_project', { reference }, 300_000);
  if (!reference) return { content: [text(await writeBase64(target, CWD, String(r.data)))] };
  // 参照だけ: プロジェクトのファイルから見た場所も書いておく (フォルダごと動かしても開けるように)
  const data = JSON.parse(Buffer.from(String(r.data), 'base64').toString('utf8'));
  for (const asset of data.assets) if (asset.source) asset.relative = path.relative(path.dirname(target), asset.source);
  const unknown = data.assets.filter((x: { source?: string }) => !x.source).map((x: { name: string }) => x.name);
  const saved = await writeBase64(target, CWD, Buffer.from(JSON.stringify(data, null, 1)).toString('base64'));
  return { content: [text({ ...saved, note: unknown.length ? `元の場所が分からないファイル (ページで直接読み込んだもの): ${unknown.join('、')}。開くときはプロジェクトと同じフォルダから探します` : undefined })] };
});
tool('open_project', 'プロジェクト (.wgp / .wgpj) を開く。.wgpj は参照しているファイルを手元から探して送る', {
  path: z.string(), allowMissing: z.boolean().optional().describe('.wgpj で見つからないファイルがあっても、なしで開く'),
}, async a => {
  const p = path.resolve(CWD, a.path);
  const bytes = await readFile(p);
  const files = [];
  if (bytes[0] === 0x7b) { // .wgpj (JSON): 参照しているファイルを探す
    const data = JSON.parse(bytes.toString('utf8'));
    for (const asset of data.assets ?? []) {
      const found = await findAsset(asset, path.dirname(p));
      if (!found) continue;
      const { files: [f] } = await readAsRemoteFiles([found]);
      files.push({ ...f, asset: asset.id });
    }
  }
  const r = await call('open_project', { data: bytes.toString('base64'), name: path.basename(p), files, allowMissing: a.allowMissing }, 300_000);
  return { content: [text(r)] };
});

await server.connect(new StdioServerTransport());
const shutdown = () => { bridge.close(); appServer?.close(); process.exit(0); };
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
