import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { modelsMiddleware } from './mcp/models.ts'
import { statusMiddleware } from './mcp/status.ts'

// ページが MCP サーバーにつなぐ前に、動いているかを問い合わせる場所と、models/ フォルダのモデルの一覧 (開発サーバーとプレビューで答える)
const mcpStatus = (): Plugin => ({
  name: 'webgl-grid-mcp-status',
  configureServer: server => { server.middlewares.use(statusMiddleware); server.middlewares.use(modelsMiddleware) },
  configurePreviewServer: server => { server.middlewares.use(statusMiddleware); server.middlewares.use(modelsMiddleware) },
})

export default defineConfig({
  plugins: [react(), mcpStatus()],
  // 出力 (dist) をどのフォルダに置いても開けるように、相対パスで参照する
  base: './',
  test: {
    // 単体テスト (src の中の *.test.ts(x))。e2e (e2e/) は Playwright で別に動かす
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
