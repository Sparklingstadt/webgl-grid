import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { remotePortFromSearch } from './core/remote';
import { Engine } from './engine';
import { BUILTIN_ADDONS } from './addons';
import { startLang } from './i18n';
import { indexedDbStore } from './engine/project/autosaveStore';
import App from './ui/App';
import { EngineProvider } from './ui/EngineContext';
import './ui/styles.css';

startLang(); // 画面の言語 (前に選んだもの・ブラウザの言語)
const engine = new Engine();
// 動作確認用: ?debug を付けて開いたときだけ、エンジンをコンソール (と e2e テスト) から触れるようにする
if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { engine, THREE });
// ?mcp (=ポート番号) を付けて開いたときは、MCP サーバーにつないで外から操作できるようにする
const mcpPort = remotePortFromSearch(location.search);
if (mcpPort) engine.remote.connect(mcpPort);
// アドオン (組み込みとインストールしたもの。前に有効にしていたものを有効にする)
void engine.addons.start(BUILTIN_ADDONS);
// 自動保存 (ブラウザの中に場面をしまう)。ページを隠すときは待たずに保存する
void indexedDbStore().then(store => engine.autosave.start(store));
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void engine.autosave.saveNow(); });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EngineProvider engine={engine}>
      <App />
    </EngineProvider>
  </StrictMode>,
);
