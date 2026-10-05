// --- Ray-MMD が必要とするものを調べて表にする (DDS の形式・レンダーターゲット・ResourceName・ScriptOrder) ---
// 使い方: npm run ray:survey (= node scripts/ray-survey.ts)。結果は docs/superpowers/notes/2026-10-05-ray-mmd-survey.md に書く。
// 1 の DDS は fx/ray-mmd-1.5.2/ (Git に入れないバイナリ) を読む。なければ「未調査」と書いて続ける。
// 2・3 は third_party/ray-mmd-1.5.2/ (テキストだけ。Git に入っている) の .fx を、コンパイラの compileEffect で変換した desc から調べる。ray.conf は標準のまま。
import { mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { compileEffect } from '../src/core/fx/index.ts';
import type { Annotation, EffectDesc, TextureDecl } from '../src/core/fx/desc.ts';
import { annotation } from '../src/core/mme/annotations.ts';
import { ddsHeader, parseDds } from '../src/core/mme/dds.ts';
import { targetSpec } from '../src/core/mme/targets.ts';

const BINARY_DIR = path.resolve('fx/ray-mmd-1.5.2');
const TEXT_DIR = path.resolve('third_party/ray-mmd-1.5.2');
const OUT = path.resolve('docs/superpowers/notes/2026-10-05-ray-mmd-survey.md');
const SCREEN: [number, number] = [1920, 1080]; // targetSpec に渡す画面の大きさ (形式を調べるだけなので、何でもよい)

const byName = (a: Dirent, b: Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const rel = (p: string) => path.relative(process.cwd(), p).split(path.sep).join('/');

// folder の中のファイルを全部 (folder からの相対で '/' 区切り、名前の順に)。folder がなければ null
function walk(dir: string, prefix = ''): string[] | null {
  let list: Dirent[];
  try { list = readdirSync(dir, { withFileTypes: true }).sort(byName); } catch { return null; }
  const out: string[] = [];
  for (const e of list) {
    if (e.isDirectory()) out.push(...(walk(path.join(dir, e.name), `${prefix}${e.name}/`) ?? []));
    else if (e.isFile()) out.push(prefix + e.name);
  }
  return out;
}

const cell = (s: string | number) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
function table(head: string[], rows: (string | number)[][]): string {
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}
const text = (list: Annotation[], name: string): string | null => {
  const v = annotation(list, name)?.value;
  return v === undefined ? null : Array.isArray(v) ? v.join(',') : v;
};

const notes: string[] = [];

// --- 1. DDS ---
function surveyDds(): string {
  const files = walk(BINARY_DIR);
  if (files === null) {
    const msg = `${rel(BINARY_DIR)}/ がないので未調査`;
    console.log(`お知らせ: ${msg} (DDS の表は書きません。取ってきてからもう一度 npm run ray:survey)`);
    return msg;
  }
  const dds = files.filter(f => f.toLowerCase().endsWith('.dds'));
  interface Group { format: string; size: string; mips: number; cube: boolean; volume: boolean; n: number; example: string; error: string }
  const groups = new Map<string, Group>();
  const broken: string[] = [];
  for (const f of dds) {
    const bytes = readFileSync(path.join(BINARY_DIR, f));
    const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    try {
      const h = ddsHeader(u8);
      let error = '';
      try { parseDds(u8); } catch (e) { error = (e as Error).message; }
      const key = `${h.format}|${h.width}x${h.height}|${h.mips}|${h.cube}|${h.volume}|${error}`;
      const g = groups.get(key);
      if (g) g.n++;
      else groups.set(key, { format: String(h.format), size: `${h.width}×${h.height}`, mips: h.mips, cube: h.cube, volume: h.volume, n: 1, example: f, error });
      if (error) broken.push(`${f}: ${error}`);
    } catch (e) {
      broken.push(`${f}: ${(e as Error).message}`);
    }
  }
  const rows = [...groups.values()].sort((a, b) => a.format.localeCompare(b.format) || b.n - a.n)
    .map(g => [g.format, g.size, g.mips, g.cube ? 'キューブ' : '', g.volume ? 'ボリューム' : '', g.n, g.error ? `読めない: ${g.error}` : '読める', g.example]);
  const out = [
    `.dds は ${dds.length} 個 (${rel(BINARY_DIR)}/)。形式・大きさ・ミップ・キューブごとにまとめた。`,
    '',
    table(['形式', '大きさ', 'ミップ', 'キューブ', 'ボリューム', '個数', 'parseDds', '例'], rows),
  ];
  const byFormat = new Map<string, number>();
  for (const g of groups.values()) byFormat.set(g.format, (byFormat.get(g.format) ?? 0) + g.n);
  out.push('', `形式ごとの個数: ${[...byFormat].sort().map(([k, n]) => `${k} ${n}`).join('、') || 'なし'}`);
  out.push('', broken.length === 0 ? 'すべて parseDds で読める。' : `parseDds で読めないもの (${broken.length} 個):\n\n${broken.map(b => `- ${b}`).join('\n')}`);
  return out.join('\n');
}

// --- 2・3. .fx を変換して、desc から集める ---
interface Compiled { entry: string; desc: EffectDesc }
function compileAll(): { effects: Compiled[]; failed: string[]; total: number } | null {
  const files = walk(TEXT_DIR);
  if (files === null) return null;
  const readFile = (p: string): Uint8Array | null => {
    try { return readFileSync(path.join(TEXT_DIR, p)); } catch { return null; }
  };
  const effects: Compiled[] = [];
  const failed: string[] = [];
  const entries = files.filter(f => f.toLowerCase().endsWith('.fx'));
  for (const entry of entries) {
    const res = compileEffect(entry, readFile, { listFiles: () => files });
    if (res.ok) effects.push({ entry, desc: res.effect });
    else failed.push(`${entry}: ${res.errors[0].code} (${res.errors[0].file}:${res.errors[0].line})`);
  }
  return { effects, failed, total: entries.length };
}

const TARGET_KINDS = ['RENDERCOLORTARGET', 'RENDERDEPTHSTENCILTARGET', 'OFFSCREENRENDERTARGET'];

function sizeOf(d: TextureDecl): string {
  const parts: string[] = [];
  for (const name of ['Dimensions', 'Width', 'Height', 'ViewportRatio']) {
    const v = text(d.annotations, name);
    if (v !== null) parts.push(`${name}=${v}`);
  }
  return parts.join(' ') || '(なし = 画面と同じ)';
}

function surveyTargets(effects: Compiled[]): string {
  interface Sig { kind: string; format: string; mips: string; size: string; shared: boolean; supported: boolean; effects: Set<string>; example: string }
  const sigs = new Map<string, Sig>();
  for (const { entry, desc } of effects) {
    for (const d of desc.textures) {
      const kind = TARGET_KINDS.find(k => d.semantic?.toUpperCase() === k);
      if (!kind) continue;
      const format = text(d.annotations, 'Format') ?? '(なし)';
      const mips = text(d.annotations, 'MipLevels') ?? '(なし)';
      const size = sizeOf(d);
      const supported = targetSpec(d, SCREEN, kind === 'RENDERDEPTHSTENCILTARGET').warnings.length === 0;
      const key = [kind, format, mips, size, d.shared].join('|');
      const s = sigs.get(key);
      if (s) s.effects.add(entry);
      else sigs.set(key, { kind, format, mips, size, shared: d.shared, supported, effects: new Set([entry]), example: `${entry} の ${d.name}` });
    }
  }
  const list = [...sigs.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.format.localeCompare(b.format) || b.effects.size - a.effects.size);
  const out = [
    `${effects.length} 個の .fx を compileEffect で変換して、RENDERCOLORTARGET・RENDERDEPTHSTENCILTARGET・OFFSCREENRENDERTARGET の宣言を集めた。`,
    '「エフェクト数」は、その宣言を (#include 経由も含めて) 持つ .fx の数。',
    '',
    table(['種類', 'Format', 'MipLevels', '大きさ', 'shared', 'targets.ts', 'エフェクト数', '例'],
      list.map(s => [s.kind, s.format, s.mips, s.size, s.shared ? 'shared' : '', s.supported ? '対応' : '未対応', s.effects.size, s.example])),
  ];
  const unsupported = list.filter(s => !s.supported);
  out.push('', '#### Task 7 で足す', '');
  if (unsupported.length === 0) out.push('`src/core/mme/targets.ts` (Framebuffers が使う) にない形式はない。');
  else {
    out.push('`src/core/mme/targets.ts` (`src/engine/mme/Framebuffers.ts` が使う) にまだない形式。いまは警告を出して既定 (色は A8R8G8B8、深度は D24S8) にする:', '');
    const byFormat = new Map<string, Sig[]>();
    for (const s of unsupported) byFormat.set(`${s.kind} ${s.format}`, [...(byFormat.get(`${s.kind} ${s.format}`) ?? []), s]);
    for (const [k, v] of byFormat) out.push(`- ${k}: ${v.reduce((n, s) => n + s.effects.size, 0)} 件の宣言 (例: ${v[0].example})`);
  }
  const offscreen = list.filter(s => s.kind === 'OFFSCREENRENDERTARGET');
  if (offscreen.length > 0) out.push('', `OFFSCREENRENDERTARGET は ${new Set(offscreen.flatMap(s => [...s.effects])).size} 個の .fx にある (いまの \`semantics.ts\` では unsupported)。`);
  return out.join('\n');
}

function surveyResources(effects: Compiled[]): string {
  const byExt = new Map<string, { n: number; values: Set<string>; example: string }>();
  const orders = new Map<string, { n: number; example: string }>();
  const classes = new Map<string, { n: number; example: string }>();
  const bump = (m: Map<string, { n: number; example: string }>, key: string, example: string) => {
    const e = m.get(key);
    if (e) e.n++;
    else m.set(key, { n: 1, example });
  };
  for (const { entry, desc } of effects) {
    for (const d of [...desc.textures, ...desc.params]) {
      const r = text(d.annotations, 'ResourceName');
      if (r !== null) {
        const ext = path.posix.extname(r.replace(/\\/g, '/')).toLowerCase() || '(拡張子なし)';
        const e = byExt.get(ext);
        if (e) { e.n++; e.values.add(r); } else byExt.set(ext, { n: 1, values: new Set([r]), example: `${entry} の ${d.name}: ${r}` });
      }
      const order = text(d.annotations, 'ScriptOrder');
      if (order !== null) bump(orders, order, `${entry} の ${d.name}`);
      const cls = text(d.annotations, 'ScriptClass');
      if (cls !== null) bump(classes, cls, `${entry} の ${d.name}`);
    }
  }
  const out = ['#### ResourceName の拡張子', '',
    table(['拡張子', '宣言の数', '異なる値の数', '値 (14 個以下ならすべて、多ければ例)'],
      [...byExt].sort().map(([k, v]) => [k, v.n, v.values.size, v.values.size <= 14 ? [...v.values].sort().join('、') : v.example])), '',
    '#### ScriptOrder', '',
    table(['値', '宣言の数', '例'], [...orders].sort().map(([k, v]) => [k, v.n, v.example])), '',
    '#### ScriptClass', '',
    table(['値', '宣言の数', '例'], [...classes].sort().map(([k, v]) => [k, v.n, v.example]))];
  return out.join('\n');
}

// --- 書く ---
const compiled = compileAll();
const sections: string[] = ['# Ray-MMD 1.5.2 の調査', '',
  '`npm run ray:survey` (`scripts/ray-survey.ts`) が書く。手で直さない。', '',
  '## 1. DDS の形式', '', surveyDds(), ''];
if (compiled === null) {
  notes.push(`${rel(TEXT_DIR)}/ がないので、2・3 は未調査`);
  sections.push('## 2. レンダーターゲット', '', notes[0], '', '## 3. ResourceName・ScriptOrder', '', notes[0], '');
} else {
  sections.push('## 2. レンダーターゲット', '', surveyTargets(compiled.effects), '',
    '## 3. ResourceName・ScriptOrder', '', surveyResources(compiled.effects), '',
    '## 変換の結果', '', `${compiled.total} 個の .fx のうち ${compiled.effects.length} 個を変換できた。`,
    compiled.failed.length === 0 ? '' : `\n変換できなかったもの (${compiled.failed.length} 個。上の表には入っていない):\n\n${compiled.failed.map(f => `- ${f}`).join('\n')}`, '');
  console.log(`${rel(TEXT_DIR)}/: .fx ${compiled.total} 個のうち ${compiled.effects.length} 個を変換`);
}
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, `${sections.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`);
console.log(`書きました: ${rel(OUT)}`);
