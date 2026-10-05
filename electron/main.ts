import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveApp } from '../mcp/appServer.ts';

// --- デスクトップ版 (Electron) ---
// ビルドしたアプリ (dist/) を、MCP サーバーと同じ仕組み (appServer.ts) で 127.0.0.1 から配り、窓で開く。
// ブラウザに覚えておく設定・自動保存はページの場所 (ポート) ごとなので、ポートは決まった番号を使う (ふさがっていれば次の番号)。
// models フォルダ (自分の PMX モデル・モーション・曲の置き場) は「書類/webgl-grid/models」(環境変数 WEBGL_GRID_MODELS_DIR で変えられる)。メニューの「models フォルダを開く」で開ける。
// fx フォルダ (自分の MME のエフェクト置き場) も同じく「書類/webgl-grid/fx」(環境変数 WEBGL_GRID_FX_DIR)。メニューの「fx フォルダを開く」で開ける。
// MCP サーバー (npm run mcp) が動いていれば、「ファイル > 外部から操作 (MCP) を受け付ける」でつながる
const PORT = 17458, TRIES = 20;
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const modelsDir = process.env.WEBGL_GRID_MODELS_DIR || path.join(app.getPath('documents'), 'webgl-grid', 'models'); // (環境変数で変えられる)
const fxDir = process.env.WEBGL_GRID_FX_DIR || path.join(app.getPath('documents'), 'webgl-grid', 'fx'); // (環境変数で変えられる)

let server: Server | null = null, url = '';

async function start() {
  await mkdir(modelsDir, { recursive: true });
  await writeFile(path.join(modelsDir, 'ここにモデルを置く.md'),
    '# models フォルダ\n\nフォルダごとに .pmx とテクスチャを置くと、アプリの「ファイル > models フォルダから読み込む…」から選べます。\n.vmd (モーション)・.vpd (ポーズ)・曲 (.mp3・.wav など) も置けます。\n', { flag: 'wx' }).catch(() => {});
  process.env.WEBGL_GRID_MODELS_DIR = modelsDir;
  await mkdir(fxDir, { recursive: true });
  await writeFile(path.join(fxDir, 'ここにエフェクトを置く.md'),
    '# fx フォルダ\n\nエフェクトの一式ごとのフォルダに .fx とそれが読むファイルを置くと、アプリの MME 互換の欄の「fx/ から選ぶ」から選べます。\nfx/ の直下のファイルは、fx という名前のフォルダ 1 つとして読みます。\n', { flag: 'wx' }).catch(() => {});
  process.env.WEBGL_GRID_FX_DIR = fxDir;
  for (let i = 0; i < TRIES && !server; i++) {
    server = await serveApp(dist, PORT + i).catch(() => null);
    if (server) url = `http://127.0.0.1:${PORT + i}/`;
  }
  if (!server) throw new Error(`アプリを配れませんでした (${PORT}〜${PORT + TRIES - 1} がふさがっています)`);
  Menu.setApplicationMenu(menu());
  open();
}

function open() {
  const win = new BrowserWindow({ width: 1440, height: 900, minWidth: 640, minHeight: 480, backgroundColor: '#3d3d3d', title: 'webgl-grid', show: false });
  win.once('ready-to-show', () => win.show());
  // ページの中のリンク (ほかのサイト) は、いつものブラウザで開く
  win.webContents.setWindowOpenHandler(({ url: to }) => {
    if (!to.startsWith(url)) void shell.openExternal(to);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, to) => { if (!to.startsWith(url)) { e.preventDefault(); void shell.openExternal(to); } });
  void win.loadURL(url);
}

// メニュー: アプリ・編集 (コピー・貼り付けを文字の欄で使う)・表示・ウインドウ (Ctrl+Z などのキーはページが受け取る)
function menu() {
  const mac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'ファイル',
      submenu: [
        { label: 'models フォルダを開く', click: () => void shell.openPath(modelsDir) },
        { label: 'fx フォルダを開く', click: () => void shell.openPath(fxDir) },
        { type: 'separator' },
        mac ? { role: 'close', label: '閉じる' } : { role: 'quit', label: '終了' },
      ],
    },
    { role: 'editMenu', label: '編集' },
    {
      label: '表示',
      submenu: [
        { role: 'reload', label: '読み込み直す' },
        { role: 'toggleDevTools', label: '開発者ツール' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'フルスクリーン' },
      ],
    },
    { role: 'windowMenu', label: 'ウインドウ' },
  ];
  return Menu.buildFromTemplate(template);
}

// 2 つ目を起動したら、前の窓を前に出す (同じページを 2 つ開くと、自動保存が取り合いになる)
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(start).catch(err => {
    console.error(err);
    app.quit();
  });
  app.on('activate', () => { if (server && !BrowserWindow.getAllWindows().length) open(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('will-quit', () => { server?.close(); });
}
