import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { Engine } from './engine';
import App from './ui/App';
import { EngineProvider } from './ui/EngineContext';
import './ui/styles.css';

const engine = new Engine();
// 動作確認用: ?debug を付けて開いたときだけ、エンジンをコンソール (と e2e テスト) から触れるようにする
if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { engine, THREE });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EngineProvider engine={engine}>
      <App />
    </EngineProvider>
  </StrictMode>,
);
