import { defineConfig, devices } from '@playwright/test';

// e2e テスト: アプリをビルドして配り、本物のブラウザ (Chromium) で画面を操作して確かめる。
// WebGL は、Mac では GPU (Metal) で描く (速い)。GPU のない CI などではソフトウェア描画 (SwiftShader)。
// E2E_GL=gpu / E2E_GL=software で切り替えられる
// e2e 用のサーバーのポート (よく使われる 5173・5174 は、ほかのプロジェクトの開発サーバーとぶつかりやすいので避ける)
const PORT = Number(process.env.E2E_PORT) || 41730;
const GPU = process.env.E2E_GL ? process.env.E2E_GL === 'gpu' : process.platform === 'darwin' && !process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'retain-on-failure',
    launchOptions: { args: GPU ? ['--use-angle=metal', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }, grepInvert: /@mobile/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  // 開発サーバーは何百ものモジュールを 1 つずつ配るので、テストごとのページの読み込みが遅い。
  // ビルドした 1 つのファイルを配る vite preview で動かす (ビルドは 1 秒ほど)
  webServer: {
    command: `npx vite build --logLevel error && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
  },
});
