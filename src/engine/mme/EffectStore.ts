import { t } from '../../core/i18n';
import { Emitter } from '../../core/events';
import { compileEffect, type EffectResult } from '../../core/fx/index.ts';
import { normalizePath } from '../../core/fx/source.ts';
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

// フォルダの索引: 小文字にしたパス → フォルダの本当のパス (同じものがいくつかあれば一覧の先のもの。コンパイラの resolveFile と同じ)。
// 割り当ては毎フレーム材質ごとに引くので、大文字小文字の違うパス (Ray-MMD の DefaultEffect の materials/… と Materials/ など) で
// 毎回ファイルの一覧をなめない。フォルダの中身を変えたら (addFolder・restore) dropIndex で捨て、次に引くときに作り直す
const indexes = new WeakMap<EffectFolder, Map<string, string>>();
function indexOf(folder: EffectFolder): Map<string, string> {
  let index = indexes.get(folder);
  if (index) return index;
  index = new Map();
  for (const p of new Set([...folder.files.keys(), ...folder.text.keys()])) {
    const key = normalizePath(p).toLowerCase();
    if (!index.has(key)) index.set(key, p);
  }
  indexes.set(folder, index);
  return index;
}
function dropIndex(folder: EffectFolder): void {
  indexes.delete(folder);
}

// フォルダの中のパスを、コンパイラの #include と同じく大文字小文字と '\' を無視して探す (書かれたとおりのものが先)。なければ null
export function findFile(folder: EffectFolder, path: string): string | null {
  const norm = normalizePath(path);
  if (folder.files.has(norm) || folder.text.has(norm)) return norm;
  return indexOf(folder).get(norm.toLowerCase()) ?? null;
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

// 使うファイル (画像など) として used に足す (読まない。保存するファイルを決めるため)。大文字小文字を無視して探し、なければ false
export function markUsed(folder: EffectFolder, path: string): boolean {
  const found = findFile(folder, path);
  if (found !== null) folder.used.add(found);
  return found !== null;
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
  readonly events = new Emitter<{ changed: [] }>(); // ポストエフェクトの一覧か、フォルダの中身が変わった
  readonly defaultEffect: LoadedEffect;
  readonly posts: { effect: LoadedEffect; enabled: boolean }[] = [];
  private builtin: EffectFolder;
  private list: EffectFolder[] = []; // 読み込んだフォルダ (builtin は入れない)
  private compiled = new Map<string, Map<string, LoadedEffect>>(); // フォルダの id → パス → コンパイルしたもの
  private nextId = 1;
  private nextFolderId = 1;
  private folderChanges = 0;

  constructor(private ui: UiChannel) {
    const text = new Map([['default.fx', new TextEncoder().encode(DEFAULT_FX)]]);
    this.builtin = { id: 'builtin', name: '', files: new Map(), text, used: new Set() };
    this.defaultEffect = this.effect(this.builtin, 'default.fx');
    if (!this.defaultEffect.result.ok) throw new Error(`default.fx: ${this.defaultEffect.result.errors[0]?.message}`);
  }

  // フォルダを足した・中身を変えた回数 (画面のフォルダの .fx の一覧を作り直すため)
  get version(): number {
    return this.folderChanges;
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
    let changed = false;
    if (!folder) {
      this.list.push((folder = { id: `folder${this.nextFolderId++}`, name, files: new Map(), text: new Map(), used: new Set() }));
      changed = true;
    }
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
    if (changed) {
      dropIndex(folder);
      this.compiled.delete(folder.id);
      this.folderChanges++;
      this.recompilePosts([folder]);
      this.events.emit('changed');
    }
    return folder;
  }

  // 保存したフォルダを、保存したときの id と名前で作り直す (プロジェクトを開くとき。同じ id のフォルダは置き換える)。
  // files: フォルダからの相対パスと File (見つからなければ null で、そのファイルなしで作る。保存したフォルダにないものは捨てる)。
  // 文字のファイルは読んでおく。次に読むフォルダの id は、作り直したものと重ならないようにする。
  // 読めなければ (File.arrayBuffer の失敗など) 何も変えずに例外を投げる
  async restore(folders: { id: string; name: string }[], files: { folder: string; path: string; file: File | null }[]): Promise<void> {
    const made = folders.map(({ id, name }): EffectFolder => ({ id, name, files: new Map(), text: new Map(), used: new Set() }));
    for (const { folder: id, path: raw, file } of files) {
      const folder = made.find(f => f.id === id);
      if (!folder || !file) continue;
      const path = normalizePath(raw);
      folder.files.set(path, file);
      if (isText(path)) folder.text.set(path, new Uint8Array(await file.arrayBuffer()));
    }
    for (const folder of made) {
      dropIndex(folder);
      this.list = this.list.filter(f => f.id !== folder.id);
      this.list.push(folder);
      this.compiled.delete(folder.id);
      const n = /^folder(\d+)$/.exec(folder.id);
      if (n) this.nextFolderId = Math.max(this.nextFolderId, Number(n[1]) + 1);
    }
    this.folderChanges++;
    this.recompilePosts(made);
    this.events.emit('changed');
  }

  // 読み込んだフォルダを全部消す (最初の状態に戻すとき。default.fx は残す。id は使い回さない)
  clearFolders(): void {
    if (this.list.length === 0) return;
    for (const f of this.list) {
      dropIndex(f);
      this.compiled.delete(f.id);
    }
    this.list = [];
    this.folderChanges++;
    this.events.emit('changed');
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

  // 中身を変えたフォルダの .fx のポストエフェクトを、新しい中身でコンパイルし直したものにする (並びとオン・オフはそのまま)。
  // (割り当ては描くときに引き直すが、ポストエフェクトの一覧は LoadedEffect を持つので。開いたときに見つからなかった .fx も、
  // 同じフォルダを読み直すと直る。知らせるのは呼ぶ側 (フォルダの中身が変わったら、いつも知らせる))
  private recompilePosts(folders: EffectFolder[]): void {
    for (const p of this.posts) {
      const folder = folders.find(f => f.id === p.effect.folder.id);
      if (folder) p.effect = this.effect(folder, p.effect.entry);
    }
  }

  // 一覧を置き換える (プロジェクトを開くとき)
  setPosts(posts: { effect: LoadedEffect; enabled: boolean }[]): void {
    this.posts.splice(0, this.posts.length, ...posts.map(p => ({ ...p })));
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
