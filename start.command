#!/bin/sh
# webgl-grid を起動する (Finder でダブルクリックしても、ターミナルで ./start.command でも)。
# はじめてなら npm install し、npm run build で dist/ に書き出してから、http://localhost:4173/ で配ってブラウザで開く。
# 4173 がふさがっていたら止まる (ほかのプロジェクトのポートへずれないように)。止めるのは Ctrl+C
cd "$(dirname "$0")" || exit 1
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js (npm) が見つかりません。https://nodejs.org/ から入れてください" >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  npm install || exit 1
fi
npm run build || exit 1
exec npx vite preview --port 4173 --strictPort --open
