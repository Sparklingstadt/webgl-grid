import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// e2e テスト: アプリをビルドして配り、本物のブラウザ (Chromium) で画面を操作して確かめる。
// WebGL は、Mac では GPU (Metal) で描く (速い)。GPU のない CI などではソフトウェア描画 (SwiftShader)。
// E2E_GL=gpu / E2E_GL=software で切り替えられる
// e2e 用のサーバーのポート (よく使われる 5173・5174 は、ほかのプロジェクトの開発サーバーとぶつかりやすいので避ける)
const PORT = Number(process.env.E2E_PORT) || 41730;
export const MODELS_DIR = path.resolve('test-results/e2e-models');
export const FX_DIR = path.resolve('test-results/e2e-fx');
const GPU = process.env.E2E_GL ? process.env.E2E_GL === 'gpu' : process.platform === 'darwin' && !process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  // CI のマシン (ubuntu-latest、公開リポジトリは 4 コア) は、決めないとコアの半分の 2 つしか使わない。4 つで並べる
  // (手元は決めない: コアの半分)。E2E_WORKERS で変えられる
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : process.env.CI ? 4 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // CI はソフトウェア描画で遅く (シェーダーの組み立てに時間がかかる)、待つ時間を長くする
  expect: { timeout: process.env.CI ? 20_000 : 5_000 },
  timeout: process.env.CI ? 90_000 : 30_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    locale: 'ja-JP', // (テストは日本語の画面で)
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
    // models フォルダのモデル・fx フォルダのエフェクトの一覧は、テスト用のフォルダ (ふだんの models/・fx/ は使わない)
    env: { WEBGL_GRID_MODELS_DIR: MODELS_DIR, WEBGL_GRID_FX_DIR: FX_DIR },
  },
});
