import { t } from '../../core/i18n';
import { Emitter } from '../../core/events';
import { compileEffect, type EffectResult } from '../../core/fx/index.ts';
import { normalizePath, resolveFile } from '../../core/fx/source.ts';
import type { UiChannel } from '../UiChannel';
import DEFAULT_FX from './default.fx?raw';

// --- 読み込んだ .fx のフォルダと、そこからコンパイルした .fx を持つ。ポストエフェクトの一覧も持つ (物ごとの割り当ては Obj.mme) ---
// files・text・used のキーはフォルダからの相対パス ('/' 区切り)。text は文字のファイル (.fx など) を読み込んだときに読んだもの。
// 画像は使うときに files の File から読む (readBinary)。used はコンパイルで読んだパスと画像として読んだパス (保存するもの)
export interface EffectFolder { id: string; name: string; files: Map<string, File>; text: Map<string, Uint8Array>; used: Set<string> }
export interface LoadedEffect {
  id: string; name: string; entry: string; // entry はフォルダからの相対パス
  folder: EffectFolder;
  result: EffectResult; // ok でなければ描かない
}

const TEXT_EXTENSIONS = ['.fx', '.fxsub', '.fxh', '.conf', '.txt'];
const isText = (path: string) => TEXT_EXTENSIONS.some(ext => path.toLowerCase().endsWith(ext));

// フォルダからの相対パス (files と同じ順) と、選んだフォルダの名前 (なければ '')。
// 先頭のフォルダが全部のファイルで同じときだけ取る (いくつかのフォルダ・ファイルをまとめて落としたときは、そのままのパス)
function relativePaths(files: File[]): { paths: string[]; folder: string } {
  const full = files.map(f => normalizePath(f.webkitRelativePath || f.name));
  const first = full.map(p => (p.includes('/') ? p.slice(0, p.indexOf('/')) : null));
  const folder = first[0] ?? '';
  if (!folder || first.some(f => f !== folder)) return { paths: full, folder: '' };
  return { paths: full.map(p => p.slice(folder.length + 1)), folder };
}

// フォルダの中のパスを、コンパイラの #include と同じく大文字小文字と '\' を無視して探す。なければ null
const FOUND = new Uint8Array(0);
export function findFile(folder: EffectFolder, path: string): string | null {
  const has = (p: string) => folder.files.has(p) || folder.text.has(p);
  const listFiles = () => [...new Set([...folder.files.keys(), ...folder.text.keys()])];
  return resolveFile({ readFile: p => (has(p) ? FOUND : null), listFiles }, path)?.path ?? null;
}

// 画像などを File から読む (大文字小文字を無視して探す)。読んだら used に足す。なければ null
export async function readBinary(folder: EffectFolder, path: string): Promise<Uint8Array | null> {
  const found = findFile(folder, path);
  if (found === null) return null;
  const file = folder.files.get(found);
  const bytes = file ? new Uint8Array(await file.arrayBuffer()) : folder.text.get(found)!;
  folder.used.add(found);
  return bytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// 文字のファイルだけからコンパイルし、読んだパスを used に足す
function compile(folder: EffectFolder, entry: string): EffectResult {
  const readFile = (p: string) => {
    const bytes = folder.text.get(p) ?? null;
    if (bytes) folder.used.add(p);
    return bytes;
  };
  return compileEffect(entry, readFile, { listFiles: () => [...folder.text.keys()] });
}

export class EffectStore {
  readonly events = new Emitter<{ changed: [] }>();
  readonly defaultEffect: LoadedEffect;
  readonly posts: { effect: LoadedEffect; enabled: boolean }[] = [];
  private builtin: EffectFolder;
  private list: EffectFolder[] = []; // 読み込んだフォルダ (builtin は入れない)
  private compiled = new Map<string, Map<string, LoadedEffect>>(); // フォルダの id → パス → コンパイルしたもの
  private nextId = 1;
  private nextFolderId = 1;

  constructor(private ui: UiChannel) {
    const text = new Map([['default.fx', new TextEncoder().encode(DEFAULT_FX)]]);
    this.builtin = { id: 'builtin', name: '', files: new Map(), text, used: new Set() };
    this.defaultEffect = this.effect(this.builtin, 'default.fx');
    if (!this.defaultEffect.result.ok) throw new Error(`default.fx: ${this.defaultEffect.result.errors[0]?.message}`);
  }

  // フォルダの中の .fx の相対パス
  static fxFilesIn(files: File[]): string[] {
    return relativePaths(files).paths.filter(p => p.toLowerCase().endsWith('.fx')).sort();
  }

  // フォルダを読み込む (文字のファイルだけ読む)。同じ名前のフォルダがあれば、それにまとめる: ないパスは足し、
  // 同じパスで変わったもの (大きさ・更新日時。文字のファイルは中身も比べる) は新しいほうにする。
  // 中身が変わったら、そのフォルダのコンパイル結果を捨てる。共通のフォルダの名前がない (名前が '') ときは、毎回別のフォルダにする。
  // 読めなければ (File.arrayBuffer の失敗など) 何も変えずに例外を投げる
  async addFolder(files: File[]): Promise<EffectFolder> {
    const { paths, folder: name } = relativePaths(files);
    const text = new Map<string, Uint8Array>();
    for (const [i, f] of files.entries()) if (isText(paths[i])) text.set(paths[i], new Uint8Array(await f.arrayBuffer()));
    // (読んでいるあいだに同じ名前のフォルダができていれば、それにまとめる)
    let folder = name ? this.list.find(f => f.name === name) : undefined;
    if (!folder) this.list.push((folder = { id: `folder${this.nextFolderId++}`, name, files: new Map(), text: new Map(), used: new Set() }));
    let changed = false;
    for (const [i, f] of files.entries()) {
      const path = paths[i];
      const old = folder.files.get(path);
      const bytes = text.get(path);
      const oldText = folder.text.get(path);
      const same = old !== undefined && old.size === f.size && old.lastModified === f.lastModified
        && (bytes === undefined ? oldText === undefined : oldText !== undefined && sameBytes(oldText, bytes));
      if (same) continue;
      folder.files.set(path, f);
      if (bytes) folder.text.set(path, bytes);
      else folder.text.delete(path);
      changed = true;
    }
    if (changed) this.compiled.delete(folder.id);
    return folder;
  }

  folder(id: string): EffectFolder | null {
    if (id === this.builtin.id) return this.builtin;
    return this.list.find(f => f.id === id) ?? null;
  }

  folders(): EffectFolder[] {
    return [...this.list];
  }

  // フォルダの .fx をコンパイルする (フォルダとパスが同じなら使い回す。パスは大文字小文字を無視して探す)。
  // 失敗しても LoadedEffect を返し、初めて失敗したときだけ最初のエラーをお知らせに出す
  effect(folder: EffectFolder, path: string): LoadedEffect {
    const entry = findFile(folder, path) ?? normalizePath(path);
    let byPath = this.compiled.get(folder.id);
    if (!byPath) this.compiled.set(folder.id, (byPath = new Map()));
    const hit = byPath.get(entry);
    if (hit) return hit;
    const name = folder.name ? `${folder.name}/${entry}` : entry;
    const result = compile(folder, entry);
    if (!result.ok) {
      const e = result.errors[0];
      const error = e ? `${e.code} ${e.file}:${e.line} ${e.message}` : '';
      this.ui.toast(t('{name} をコンパイルできませんでした: {error}', { name, error }));
    }
    const loaded: LoadedEffect = { id: `fx${this.nextId++}`, name, entry, folder, result };
    byPath.set(entry, loaded);
    return loaded;
  }

  // ポストエフェクトを全部外す
  clear(): void {
    if (this.posts.length === 0) return;
    this.posts.length = 0;
    this.events.emit('changed');
  }

  addPost(e: LoadedEffect): void {
    this.posts.push({ effect: e, enabled: true });
    this.events.emit('changed');
  }

  // 上 (-1) か下 (1) へ 1 つ動かす。端からは動かない
  movePost(i: number, d: -1 | 1): void {
    const j = i + d;
    if (i < 0 || i >= this.posts.length || j < 0 || j >= this.posts.length) return;
    [this.posts[i], this.posts[j]] = [this.posts[j], this.posts[i]];
    this.events.emit('changed');
  }

  setPostEnabled(i: number, on: boolean): void {
    const p = this.posts[i];
    if (!p) return;
    p.enabled = on;
    this.events.emit('changed');
  }

  removePost(i: number): void {
    if (i < 0 || i >= this.posts.length) return;
    this.posts.splice(i, 1);
    this.events.emit('changed');
  }
}
