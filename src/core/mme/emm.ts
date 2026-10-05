import { decodeSource } from '../fx/source.ts';
import { t } from '../i18n.ts';
import { encodeShiftJis } from '../sjis.ts';

// --- MME のエフェクト割当ファイル (.emm) を読む・書く (書式: docs/superpowers/notes/2026-10-05-emm-format.md) ---
// MME の書式: Shift_JIS・CRLF・`キー = 値`。[Info] の Version = 3、[Object] の Pmd<n>/Acs<n> = ファイル (番号は通し)、
// [Effect] (Main) と [Effect@<オフスクリーンの名前>] (Owner = 宣言した物) に Pmd<n> / Pmd<n>[<材質>] = .fx のパスか none、
// .show = true/false (false は描かない)。自作の .emm も読むので、読むときは大文字小文字・空白・'/'・Obj<n> を許す

// 1 つの割り当て: 物 ([Object] の番号) 全体 (material が null) か材質の、値 (.fx のパス・'none'・'hide') と描くか (.show)
export interface EmmEntry { object: number; material: number | null; value: string; show?: boolean }
// owners: オフスクリーンのタブを宣言した物 (tab はその物を描いたオフスクリーンのタブ。Main で宣言したものはなし)
export interface EmmDoc {
  objects: { index: number; file: string }[];
  tabs: Record<string /* 'Main' かオフスクリーンの名前 */, EmmEntry[]>;
  owners?: Record<string, { object: number; tab?: string }>;
}

const VERSION = '3';
const OBJECT_KEY = /^(pmd|acs|obj)\s*(\d+)$/i;
const ENTRY_KEY = /^(pmd|acs|obj)\s*(\d+)\s*(?:\[\s*(\d+)\s*\])?\s*(?:\.\s*(show))?$/i;
const OWNER = /^(pmd|acs|obj)\s*(\d+)\s*(?:@\s*(.+))?$/i;
const SHOW: Record<string, boolean> = { true: true, false: false, 1: true, 0: false };

// .emm のバイト列を文字にする (BOM → UTF-8 → Shift_JIS。改行は '\n')
export const decodeEmm = (bytes: Uint8Array): string => decodeSource(bytes);
// MME が読む Shift_JIS にする (表せない文字は '?')
export const encodeEmm = (text: string): Uint8Array => encodeShiftJis(text);

const unquote = (v: string) => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).trim() : v);
const byKey = (a: EmmEntry, b: EmmEntry) => a.object - b.object || (a.material ?? -1) - (b.material ?? -1);

// .emm の文字を読む。読めない行・知らない版・[Object] にない物の割り当ては警告 (t() を通した文) にまとめて飛ばす
export function parseEmm(text: string): { doc: EmmDoc; warnings: string[] } {
  const objects = new Map<number, string>();
  const tabs = new Map<string, Map<string, EmmEntry>>();
  const owners: NonNullable<EmmDoc['owners']> = {};
  const bad: number[] = [];
  let version: string | null = null;
  // いまの節: info・object・タブ (同じ名前のオフスクリーンの 2 つめ以降 (名前(k)) は、先の節に出てこなかった物・材質だけを足す)・知らない節
  let section: { kind: 'info' } | { kind: 'object' } | { kind: 'other' } | { kind: 'tab'; name: string; seen: Set<string> } = { kind: 'other' };
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    const head = /^\[(.*)\]$/.exec(line);
    if (head) {
      const name = head[1].trim();
      const lower = name.toLowerCase();
      if (lower === 'info') section = { kind: 'info' };
      else if (lower === 'object') section = { kind: 'object' };
      else if (lower === 'effect') section = { kind: 'tab', name: 'Main', seen: new Set() };
      else if (lower.startsWith('effect@') && name.length > 7) section = { kind: 'tab', name: name.slice(7).trim().replace(/\(\d+\)$/, ''), seen: new Set() };
      else section = { kind: 'other' };
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) { bad.push(i + 1); continue; }
    const key = line.slice(0, eq).trim(), value = unquote(line.slice(eq + 1).trim());
    if (section.kind === 'other') continue;
    if (section.kind === 'info') {
      if (key.toLowerCase() === 'version') version = value;
      continue;
    }
    if (section.kind === 'object') {
      const m = OBJECT_KEY.exec(key);
      const index = m ? Number(m[2]) : NaN;
      if (!m || value === '' || objects.has(index)) bad.push(i + 1);
      else objects.set(index, value);
      continue;
    }
    const lower = key.toLowerCase();
    if (lower === 'default') continue;
    if (lower === 'owner') {
      const m = OWNER.exec(value);
      if (!m) { bad.push(i + 1); continue; }
      const tab = m[3]?.trim();
      if (!owners[section.name]) owners[section.name] = tab && tab.toLowerCase() !== 'main' ? { object: Number(m[2]), tab } : { object: Number(m[2]) };
      continue;
    }
    const m = ENTRY_KEY.exec(key);
    const show = m?.[4] ? SHOW[value.toLowerCase()] : undefined;
    if (!m || (m[4] && show === undefined)) { bad.push(i + 1); continue; }
    const object = Number(m[2]), material = m[3] === undefined ? null : Number(m[3]);
    const id = `${object}[${material ?? ''}]`;
    let entries = tabs.get(section.name);
    if (!entries) tabs.set(section.name, (entries = new Map()));
    if (entries.has(id) && !section.seen.has(id)) continue; // (先の節のもの)
    section.seen.add(id);
    const entry = entries.get(id) ?? { object, material, value: 'none' };
    entries.set(id, entry);
    if (m[4]) entry.show = show;
    else entry.value = ['none', 'hide'].includes(value.toLowerCase()) ? value.toLowerCase() : value;
  }

  const warnings: string[] = [];
  if (version !== null && version !== VERSION) warnings.push(t('.emm の Version {version} は知らない版です (3 として読みます)', { version }));
  if (bad.length) warnings.push(t('.emm の {lines} 行目は読めないので飛ばしました', { lines: bad.join('・') }));
  const unknown = new Set<number>();
  const doc: EmmDoc = {
    objects: [...objects].sort((a, b) => a[0] - b[0]).map(([index, file]) => ({ index, file })),
    tabs: {},
  };
  for (const [name, entries] of tabs) {
    for (const e of entries.values()) if (!objects.has(e.object)) unknown.add(e.object);
    const known = [...entries.values()].filter(e => objects.has(e.object));
    if (known.length) doc.tabs[name] = known.sort(byKey);
  }
  if (unknown.size) warnings.push(t('.emm の [Object] にない物 {objects} の割り当てを飛ばしました', { objects: [...unknown].sort((a, b) => a - b).join('・') }));
  if (Object.keys(owners).length) doc.owners = owners;
  return { doc, warnings };
}

// 物の頭: アクセサリ (.x・.vac) は Acs、ほか (.pmx・.pmd) は Pmd
const prefixOf = (file: string | undefined) => (file && /\.(x|vac)$/i.test(file) ? 'Acs' : 'Pmd');

// MME の書式の文字にする (CRLF。バイト列にするのは encodeEmm)。[Effect] (Main) はいつも書く。値は渡されたまま書く
export function writeEmm(doc: EmmDoc): string {
  const files = new Map(doc.objects.map(o => [o.index, o.file]));
  const keyOf = (object: number) => `${prefixOf(files.get(object))}${object}`;
  const lines = ['[Info]', `Version = ${VERSION}`, '', '[Object]', ...doc.objects.map(o => `${keyOf(o.index)} = ${o.file}`), ''];
  const tab = (name: string, entries: EmmEntry[]) => {
    const owner = doc.owners?.[name];
    lines.push(name === 'Main' ? '[Effect]' : `[Effect@${name}]`);
    if (name === 'Main') lines.push('Default = none');
    else if (owner) lines.push(`Owner = ${keyOf(owner.object)}${owner.tab ? `@${owner.tab}` : ''}`);
    for (const e of [...entries].sort(byKey)) {
      const key = `${keyOf(e.object)}${e.material === null ? '' : `[${e.material}]`}`;
      lines.push(`${key} = ${e.value}`);
      if (e.show !== undefined) lines.push(`${key}.show = ${e.show}`);
    }
    lines.push('');
  };
  tab('Main', doc.tabs.Main ?? []);
  for (const [name, entries] of Object.entries(doc.tabs)) if (name !== 'Main') tab(name, entries);
  return `${lines.join('\r\n')}\r\n`;
}

// .emm の .fx のパスに合う、読み込んだフォルダの .fx: 「フォルダの名前/フォルダの中のパス」と後ろから区切りごとに
// (大文字小文字と '\' を無視して) 比べ、いちばん多く合うもの (ファイル名は合うこと)。同じ数なら先のフォルダ、フォルダの中では先のファイル
export function matchFxPath(path: string, folders: { id: string; name: string; files: string[] }[]): { folder: string; path: string } | null {
  const split = (p: string) => p.toLowerCase().split(/[\\/]+/).filter(s => s !== '' && s !== '.');
  const want = split(path);
  if (!want.length) return null;
  let best: { folder: string; path: string } | null = null, bestScore = 0;
  for (const folder of folders) {
    const base = split(folder.name);
    for (const file of folder.files) {
      const have = [...base, ...split(file)];
      let n = 0;
      while (n < want.length && n < have.length && want[want.length - 1 - n] === have[have.length - 1 - n]) n++;
      if (n > bestScore) [best, bestScore] = [{ folder: folder.id, path: file }, n];
    }
  }
  return best;
}
