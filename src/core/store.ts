// 状態を入れておく小さなストア。中身を変えるときは、変わったところだけを新しい値にして丸ごと差し替える
// (React は useSyncExternalStore で、参照の違いから変化を知る。ui/EngineContext.tsx の useUi)
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
