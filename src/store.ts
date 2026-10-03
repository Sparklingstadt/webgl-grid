import { useSyncExternalStore } from 'react';

// three.js 側 (エンジン) の状態を React に知らせる小さなストア。
// 中身を変えるときは、変わったところだけを新しい値にして丸ごと差し替える (React は参照の違いで変化を知る)
export interface Store<T> {
  get(): T;
  set(patch: Partial<T>): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      let changed = false;
      for (const k in patch) {
        if (!Object.is(state[k], patch[k])) { changed = true; break; }
      }
      if (!changed) return;
      state = { ...state, ...patch };
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

// ストアの一部を読む。selector は、元の値か数値・文字列などを返すこと (毎回新しい物を作ると描き直しが止まらない)
export function useStore<T extends object, U>(store: Store<T>, selector: (s: T) => U): U {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
