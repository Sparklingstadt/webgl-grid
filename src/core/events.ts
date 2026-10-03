// 型付きの小さなイベント。下の層から上の層へ「起きたこと」を知らせるのに使う (上の層を import しないため)
type Handler = (...args: never[]) => void;

export class Emitter<E extends { [K in keyof E]: unknown[] }> {
  private handlers = new Map<keyof E, Set<Handler>>();

  on<K extends keyof E>(type: K, fn: (...args: E[K]) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, set = new Set());
    set.add(fn as unknown as Handler);
    return () => { set.delete(fn as unknown as Handler); };
  }

  // 登録した順に呼ぶ
  emit<K extends keyof E>(type: K, ...args: E[K]) {
    for (const fn of this.handlers.get(type) ?? []) (fn as unknown as (...a: E[K]) => void)(...args);
  }
}
