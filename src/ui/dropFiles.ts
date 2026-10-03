// --- 画面に落としたファイル (フォルダは中も全部) を集める ---
// webkitGetAsEntry でフォルダを開き、中のファイルを順に読む (readEntries は少しずつしか返さないので、空になるまで)
type Entry = { isFile: boolean; isDirectory: boolean; name: string; file?(ok: (f: File) => void, ng: (e: unknown) => void): void; createReader?(): { readEntries(ok: (l: Entry[]) => void, ng: (e: unknown) => void): void } };

async function walk(entry: Entry, path: string, out: File[]) {
  if (entry.isFile && entry.file) {
    const f = await new Promise<File>((ok, ng) => entry.file!(ok, ng));
    Object.defineProperty(f, 'webkitRelativePath', { value: path + f.name });
    out.push(f);
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    for (;;) {
      const list = await new Promise<Entry[]>((ok, ng) => reader.readEntries(ok, ng));
      if (!list.length) break;
      for (const e of list) await walk(e, `${path}${entry.name}/`, out);
    }
  }
}

export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map(i => (i as DataTransferItem & { webkitGetAsEntry?(): Entry | null }).webkitGetAsEntry?.() ?? null);
  if (!entries.some(Boolean)) return [...dt.files];
  const out: File[] = [];
  for (const e of entries) if (e) await walk(e, '', out);
  return out;
}
