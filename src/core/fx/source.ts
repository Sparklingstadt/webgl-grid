// --- .fx のソースの読み方とパス ---
export interface FileAccess { readFile(path: string): Uint8Array | null; listFiles?: () => string[] }

// BOM → UTF-8 → Shift-JIS の順に読む。改行は '\n' にそろえる
export function decodeSource(bytes: Uint8Array): string {
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); // UTF-8 の BOM は読み捨てられる
    } catch {
      text = new TextDecoder('shift_jis').decode(bytes);
    }
  }
  return text.replace(/\r\n?/g, '\n');
}

// '\' → '/'、'.' と '..' をたたむ (先頭の '..' は残す)、'//' と先頭の './' を消す
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function joinPath(dir: string, rel: string): string {
  return dir === '' ? normalizePath(rel) : normalizePath(`${dir}/${rel}`);
}

// 書かれたとおりに読めなければ、大文字小文字を無視して listFiles から探す
export function resolveFile(access: FileAccess, path: string): { path: string; bytes: Uint8Array } | null {
  const norm = normalizePath(path);
  const bytes = access.readFile(norm);
  if (bytes) return { path: norm, bytes };
  if (!access.listFiles) return null;
  const lower = norm.toLowerCase();
  for (const f of access.listFiles()) {
    if (normalizePath(f).toLowerCase() !== lower) continue;
    const b = access.readFile(f);
    if (b) return { path: f, bytes: b };
  }
  return null;
}
