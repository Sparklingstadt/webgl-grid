// Ray-MMD のファイル一式をテストで読むための小さな道具

export interface Corpus { files: Record<string, Uint8Array>; readFile(path: string): Uint8Array | null; listFiles(): string[] }

// 文字列 (どれも ASCII) をバイト列にする。パスはルートからの相対パス
export function corpusFrom(files: Record<string, string>): Corpus {
  const enc = new TextEncoder();
  const bytes: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) bytes[path] = enc.encode(text);
  const names = Object.keys(bytes).sort();
  return {
    files: bytes,
    readFile: path => (Object.hasOwn(bytes, path) ? bytes[path] : null),
    listFiles: () => names.slice(),
  };
}

const DEFINE = /^(\s*#define\s+(\w+)\s+)(\S+)(.*)$/;
const CHOICE = /^\s*\/\/\s*(\d+)\s*:/;

// ray.conf の各 #define の直前に続く「// N : …」の行の N を値の一覧とし、
// 1 つの #define だけをその値に変えたものを全部返す (いまの値と同じものは除く)
export function rayConfVariants(conf: string): { name: string; conf: string }[] {
  const lines = conf.split('\n');
  const out: { name: string; conf: string }[] = [];
  lines.forEach((line, i) => {
    const cr = line.endsWith('\r') ? '\r' : '';
    const m = DEFINE.exec(cr ? line.slice(0, -1) : line);
    if (!m) return;
    const values: string[] = [];
    for (let j = i - 1; j >= 0; j--) {
      const c = CHOICE.exec(lines[j]);
      if (!c) break;
      values.unshift(c[1]);
    }
    for (const v of values) {
      if (v === m[3]) continue;
      const changed = lines.slice();
      changed[i] = m[1] + v + m[4] + cr;
      out.push({ name: `${m[2]}=${v}`, conf: changed.join('\n') });
    }
  });
  return out;
}
