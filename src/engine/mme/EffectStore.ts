import { t } from '../../core/i18n';
import { Emitter } from '../../core/events';
import { compileEffect, type EffectResult } from '../../core/fx/index.ts';
import { normalizePath } from '../../core/fx/source.ts';
import type { UiChannel } from '../UiChannel';
import DEFAULT_FX from './default.fx?raw';

// --- 選ばれた .fx (フォルダごと) をコンパイルして持つ。物ごとの .fx とポストエフェクトの一覧も持つ ---
export interface EffectFiles { name: string; entry: string; files: Map<string, File> } // files のキーはフォルダからの相対パス ('/' 区切り)
export interface LoadedEffect {
  id: string; name: string; entry: string;
  result: EffectResult;           // ok でなければ描かない
  bytes: Map<string, Uint8Array>; // 読んだファイルの中身 (テクスチャもここから)
}

// フォルダからの相対パス (files と同じ順) と、選んだフォルダの名前 (なければ '')。
// 先頭のフォルダが全部のファイルで同じときだけ取る (いくつかのフォルダ・ファイルをまとめて落としたときは、そのままのパス)
function relativePaths(files: File[]): { paths: string[]; folder: string } {
  const full = files.map(f => normalizePath(f.webkitRelativePath || f.name));
  const first = full.map(p => (p.includes('/') ? p.slice(0, p.indexOf('/')) : null));
  const folder = first[0] ?? '';
  if (!folder || first.some(f => f !== folder)) return { paths: full, folder: '' };
  return { paths: full.map(p => p.slice(folder.length + 1)), folder };
}

function compile(entry: string, bytes: Map<string, Uint8Array>): EffectResult {
  return compileEffect(entry, path => bytes.get(path) ?? null, { listFiles: () => [...bytes.keys()] });
}

export class EffectStore {
  readonly events = new Emitter<{ changed: [] }>();
  readonly defaultEffect: LoadedEffect;
  readonly posts: { effect: LoadedEffect; enabled: boolean }[] = [];
  private objects = new Map<number, LoadedEffect>();
  private nextId = 1;

  constructor(private ui: UiChannel) {
    const bytes = new Map([['default.fx', new TextEncoder().encode(DEFAULT_FX)]]);
    const result = compile('default.fx', bytes);
    if (!result.ok) throw new Error(`default.fx: ${result.errors[0]?.message}`);
    this.defaultEffect = { id: 'default', name: 'default.fx', entry: 'default.fx', result, bytes };
  }

  // フォルダの中の .fx の相対パス
  static fxFilesIn(files: File[]): string[] {
    return relativePaths(files).paths.filter(p => p.toLowerCase().endsWith('.fx')).sort();
  }

  // 失敗しても LoadedEffect を返し、最初のエラーをお知らせに出す
  async load(files: File[], entry: string): Promise<LoadedEffect> {
    const { paths, folder } = relativePaths(files);
    const bytes = new Map<string, Uint8Array>();
    for (const [i, f] of files.entries()) bytes.set(paths[i], new Uint8Array(await f.arrayBuffer()));
    const path = normalizePath(entry);
    const name = folder ? `${folder}/${path}` : path;
    const result = compile(path, bytes);
    if (!result.ok) {
      const e = result.errors[0];
      const error = e ? `${e.code} ${e.file}:${e.line} ${e.message}` : '';
      this.ui.toast(t('{name} をコンパイルできませんでした: {error}', { name, error }));
    }
    return { id: `fx${this.nextId++}`, name, entry: path, result, bytes };
  }

  objectEffect(objId: number): LoadedEffect | null {
    return this.objects.get(objId) ?? null;
  }

  setObjectEffect(objId: number, e: LoadedEffect | null): void {
    if (e) this.objects.set(objId, e);
    else this.objects.delete(objId);
    this.events.emit('changed');
  }

  // 物を消したとき
  forgetObject(objId: number): void {
    if (this.objects.delete(objId)) this.events.emit('changed');
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
