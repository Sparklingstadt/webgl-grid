import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  // 出力 (dist) をどのフォルダに置いても開けるように、相対パスで参照する
  base: './',
  test: {
    // 単体テスト (src の中の *.test.ts(x))。e2e (e2e/) は Playwright で別に動かす
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
