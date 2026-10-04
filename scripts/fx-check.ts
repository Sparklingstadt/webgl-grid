// --- MME の .fx を GLSL に変換できるか、まとめて確かめて表にする ---
// 使い方: node scripts/fx-check.ts [フォルダ…]。引数がなければ fx/ と third_party/ray-mmd-1.5.2/。
// ルート (#include の基準になるフォルダ): fx/ は直下のフォルダ 1 つずつ (エフェクトの一式ごと) と、直下のファイル (fx/ がルート)。それ以外のフォルダは、そのものがルート。
// 報告のための道具なので、変換できないものがあっても終了コードは 0。
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { compileEffect } from '../src/core/fx/index.ts';

interface Root { dir: string; entries: string[]; files: string[] } // entries・files はルートからの相対 ('/' 区切り)
interface Row { file: string; result: string; place: string; ms: number }

const FX_DIR = path.resolve('fx');
const RAY_DIR = path.resolve('third_party/ray-mmd-1.5.2');

const byName = (a: Dirent, b: Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// 読めないフォルダは 1 行出して、ないものとして続ける (ほかのフォルダの結果は出す)
function listDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort(byName);
  } catch {
    console.log(`読めないフォルダ: ${rel(dir)}`);
    return [];
  }
}

// folder の中のファイルを全部 (ルートからの相対で、名前の順に)
function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of listDir(dir)) {
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), `${prefix}${e.name}/`));
    else if (e.isFile()) out.push(prefix + e.name);
  }
  return out;
}

const isFx = (p: string) => p.toLowerCase().endsWith('.fx');
const root = (dir: string, files: string[]): Root => ({ dir, files, entries: files.filter(isFx) });

function rootsOf(dir: string): Root[] {
  if (dir !== FX_DIR) return [root(dir, walk(dir))];
  // fx/ の直下のファイルは fx/ がルート (include を探すのも直下のファイルだけ。ほかのエフェクトの一式は混ぜない)
  const list = listDir(dir);
  const roots: Root[] = [];
  const direct = list.filter(e => e.isFile()).map(e => e.name);
  if (direct.some(isFx)) roots.push(root(dir, direct));
  for (const e of list) {
    if (e.isDirectory()) roots.push(root(path.join(dir, e.name), walk(path.join(dir, e.name))));
  }
  return roots;
}

// 全角を 2 つに数えた幅 (表をそろえる)
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)));
const rel = (p: string) => path.relative(process.cwd(), p).split(path.sep).join('/');

const args = process.argv.slice(2);
const dirs = args.length > 0 ? args.map(a => path.resolve(a)) : [FX_DIR, RAY_DIR];
const rows: Row[] = [];

for (const dir of dirs) {
  let kind: 'dir' | 'file' | 'none' = 'none';
  try { kind = statSync(dir).isDirectory() ? 'dir' : 'file'; } catch { /* ない */ }
  if (kind !== 'dir') {
    console.log(kind === 'file' ? `${rel(dir)} はフォルダではないので飛ばします` : `${rel(dir)}/ がないので飛ばします`);
    continue;
  }
  for (const r of rootsOf(dir)) {
    const readFile = (p: string): Uint8Array | null => {
      try { return readFileSync(path.join(r.dir, p)); } catch { return null; }
    };
    for (const entry of r.entries) {
      const t0 = performance.now();
      const res = compileEffect(entry, readFile, { listFiles: () => r.files });
      const ms = performance.now() - t0;
      const e = res.ok ? null : res.errors[0];
      rows.push({
        file: rel(path.join(r.dir, entry)), ms,
        result: e ? e.code : '成功',
        place: e ? `${rel(path.join(r.dir, e.file))}:${e.line}` : '',
      });
    }
  }
}

if (rows.length === 0) {
  console.log('変換する .fx がありません');
} else {
  const head: Row = { file: 'ファイル', result: '結果', place: '場所', ms: 0 };
  const cells = [head, ...rows].map((r, i) => [r.file, r.result, r.place, i === 0 ? '時間 (ms)' : r.ms.toFixed(1)]);
  const w = [0, 1, 2, 3].map(c => Math.max(...cells.map(row => width(row[c]))));
  for (const row of cells) console.log(`${pad(row[0], w[0])}  ${pad(row[1], w[1])}  ${pad(row[2], w[2])}  ${row[3].padStart(w[3])}`);

  const ok = rows.filter(r => r.result === '成功').length;
  const counts = new Map<string, number>();
  for (const r of rows) if (r.result !== '成功') counts.set(r.result, (counts.get(r.result) ?? 0) + 1);
  const slowest = rows.reduce((a, b) => (b.ms > a.ms ? b : a));
  console.log(`\n成功 ${ok} / ${rows.length}`);
  for (const [code, n] of [...counts].sort()) console.log(`  ${code}: ${n}`);
  console.log(`いちばん遅い: ${slowest.file} (${slowest.ms.toFixed(1)} ms)`);
}
