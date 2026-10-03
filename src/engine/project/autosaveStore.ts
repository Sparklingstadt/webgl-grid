// --- 自動保存の置き場所 ---
// 場面 (参照だけのプロジェクトの JSON) と、それが参照するファイルを分けてしまう。ファイルは一度入れたら入れ直さない
export interface AutosaveSession {
  id: string;            // ページを開くたびに変わる
  time: number;          // 保存した時刻 (ミリ秒)
  name: string | null;   // プロジェクトの名前
  json: string;          // 参照だけのプロジェクト (.wgpj)
  files: Record<string, string>; // asset の id → ファイルの鍵
}
export interface AutosaveStore {
  hasFile(key: string): Promise<boolean>;
  putFile(key: string, file: File): Promise<void>;
  getFile(key: string): Promise<File | null>;
  fileKeys(): Promise<string[]>;
  deleteFile(key: string): Promise<void>;
  putSession(s: AutosaveSession): Promise<void>;
  sessions(): Promise<AutosaveSession[]>;
  deleteSession(id: string): Promise<void>;
}

// テスト用: メモリの中だけ
export function memoryStore(): AutosaveStore {
  const files = new Map<string, File>(), sessions = new Map<string, AutosaveSession>();
  return {
    hasFile: async k => files.has(k),
    putFile: async (k, f) => { files.set(k, f); },
    getFile: async k => files.get(k) ?? null,
    fileKeys: async () => [...files.keys()],
    deleteFile: async k => { files.delete(k); },
    putSession: async s => { sessions.set(s.id, structuredClone(s)); },
    sessions: async () => [...sessions.values()].map(s => structuredClone(s)),
    deleteSession: async id => { sessions.delete(id); },
  };
}

// ブラウザの IndexedDB (File もそのまましまえる)。使えなければ null
export async function indexedDbStore(name = 'webgl-grid-autosave'): Promise<AutosaveStore | null> {
  if (typeof indexedDB === 'undefined') return null;
  const db = await new Promise<IDBDatabase | null>(ok => {
    try {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('files');
        req.result.createObjectStore('sessions', { keyPath: 'id' });
      };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ok(null);
    } catch {
      ok(null); // 使えない (プライベートブラウズなど)
    }
  });
  if (!db) return null;
  const run = <T>(store: 'files' | 'sessions', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
    new Promise<T>((ok, ng) => {
      const req = fn(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ng(req.error);
    });
  return {
    hasFile: async k => (await run('files', 'readonly', s => s.count(k))) > 0,
    putFile: async (k, f) => { await run('files', 'readwrite', s => s.put(f, k)); },
    getFile: async k => (await run<File | undefined>('files', 'readonly', s => s.get(k))) ?? null,
    fileKeys: async () => (await run('files', 'readonly', s => s.getAllKeys())).map(String),
    deleteFile: async k => { await run('files', 'readwrite', s => s.delete(k)); },
    putSession: async v => { await run('sessions', 'readwrite', s => s.put(v)); },
    sessions: () => run<AutosaveSession[]>('sessions', 'readonly', s => s.getAll()),
    deleteSession: async id => { await run('sessions', 'readwrite', s => s.delete(id)); },
  };
}
