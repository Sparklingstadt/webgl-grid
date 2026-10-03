import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { Engine, UiState } from '../engine';

// 画面の部品は、エンジンをこの Context から受け取る (モジュールのグローバル変数にしないので、テストで差し替えられる)
const EngineContext = createContext<Engine | null>(null);

export function EngineProvider({ engine, children }: { engine: Engine; children: ReactNode }) {
  return <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>;
}

export function useEngine(): Engine {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error('EngineProvider の中で使ってください');
  return engine;
}

// エンジンが画面に知らせる状態の一部を読む。selector は、元の値か数値・文字列などを返すこと
// (毎回新しい物を作ると描き直しが止まらない)
export function useUi<U>(selector: (s: UiState) => U): U {
  const { store } = useEngine().ui;
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
