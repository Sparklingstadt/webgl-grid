import * as THREE from 'three';
import { errorText } from '../../core/errors';
import type { Engine } from '../Engine';
import { download } from '../io/download';
import type { Obj } from '../types';
import type { SelInfo } from '../UiChannel';
import { Registry, type CommandDef, type MenuDef, type MenuId, type ObjectDataDef, type PanelDef, type PropDef, type SceneDataDef } from './registry';

// --- アドオン (Blender のアドオン): アプリに機能を足す JavaScript のモジュール ---
// アドオンは、id・名前などと register(api) を持つオブジェクトを default で書き出す ES モジュール。
// register で、api からメニュー・サイドバーのパネル・MCP の命令・物ごとの設定・場面の設定・毎フレームの処理を足す。
// 足したものは、アドオンを切ると全部外す (register が返した関数・unregister も呼ぶ)。
// 組み込みのアドオン (src/addons) と、ファイルからインストールしたアドオン (ブラウザにしまう) がある。
// 有効にしたアドオンは覚えておき、次に開いたときも有効にする
export interface AddonModule {
  id: string;           // 英小文字・数字・-・_ (MCP の命令・保存するデータの名前の頭に付く)
  name: string;
  version?: string;
  author?: string;
  description?: string;
  category?: string;
  enabledByDefault?: boolean; // 組み込みのアドオンを、最初から有効にしておく (切ったら、切ったまま覚えておく)
  register(api: AddonApi): void | (() => void) | Promise<void | (() => void)>;
  unregister?(api: AddonApi): void;
}
export interface AddonInfo {
  id: string; name: string; version: string; author: string; description: string; category: string;
  source: 'builtin' | 'installed';
  enabled: boolean;
  enabledByDefault: boolean;
  error: string | null; // 有効にできなかったわけ
  contributes: AddonContributions; // 足しているもの (有効なときだけ)
}
// アドオンが足しているもの (アドオンマネージャーに出す)
export interface AddonContributions {
  menus: { menu: MenuId; label: string }[];
  panels: { tab: string; title: string }[];
  commands: string[];
  objectData: string[]; // 物ごとの値の名前
  sceneData: string[];  // 場面の値の名前
}

// 物ごとの値 (プロジェクトに保存し、元に戻せる)
export interface ObjectData<T> { get(obj: Obj): T | null; set(obj: Obj, value: T | null): void }
// 場面の値 (プロジェクトに保存し、history なら元に戻せる)
export interface SceneData<T> { get(): T; set(value: T): void }

// アドオンに渡す窓口。ここから足したものは、アドオンを切ると外れる
export interface AddonApi {
  readonly id: string;
  readonly engine: Engine;      // アプリの全部 (何でもできるが、変わるかもしれない)
  readonly THREE: typeof THREE; // アプリと同じ three.js (形・材質を作るとき。別に読み込むと、アプリの three.js と混ざらない)
  toast(text: string, ms?: number): void;
  requestDraw(): void;
  refresh(): void; // パネルを描き直す (値を変えたとき)
  expose(value: unknown): void; // ほかから使える窓口を出す (engine.addons.exposed(id) で受け取る。切るとなくなる)
  addCommand(name: string, def: { description?: string; params?: Record<string, string>; run(params: Record<string, unknown>): unknown }): () => void;
  addMenuItem(def: { menu: MenuId; label: string; run(): void; enabled?(): boolean }): () => void;
  addPanel(def: { title: string; tab?: string; poll?(sel: SelInfo | null): boolean; props?(): PropDef[]; draw?(el: HTMLElement): void | (() => void); component?: unknown }): () => void;
  // apply は、値を変えたとき・開いたとき・元に戻したときと、有効にしたとき (値のある物) に呼ぶ。切ったときは null で呼ぶ (値は覚えておく)
  addObjectData<T>(def: { key: string; label: string; aliases?: string[]; apply?(obj: Obj, value: T | null): void; normalize?(raw: unknown): T | null }): ObjectData<T>;
  addSceneData<T>(def: { key: string; label: string; default: T; history?: boolean; apply?(value: T): void; normalize?(raw: unknown): T }): SceneData<T>;
  onFrame(update: (dt: number) => void, active?: () => boolean): () => void; // 毎フレーム (active のあいだ。省くとずっと)
  onBeforeRender(fn: () => void): () => void; // 描く前 (物の位置を決めたあと。レンダリングのときも)
}

// インストールしたアドオンのコードと、有効にしたアドオン・見たことのある組み込みのアドオンの覚え書き
interface Saved { enabled: string[]; installed: Record<string, string>; seen?: string[] }
export interface AddonStorage {
  load(): Saved;
  save(v: Saved): void;
}
const STORAGE_KEY = 'webgl-grid.addons';
export const localAddonStorage = (): AddonStorage => ({
  load() {
    try {
      const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      return {
        enabled: Array.isArray(v?.enabled) ? v.enabled : [], installed: v?.installed && typeof v.installed === 'object' ? v.installed : {},
        seen: Array.isArray(v?.seen) ? v.seen : [],
      };
    } catch { return { enabled: [], installed: {} }; }
  },
  save(v) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch { /* (しまえないときは、覚えないだけ) */ } },
});
export const memoryAddonStorage = (): AddonStorage => {
  let v: Saved = { enabled: [], installed: {}, seen: [] };
  return { load: () => structuredClone(v), save: x => { v = structuredClone(x); } };
};

interface Entry { module: AddonModule; source: AddonInfo['source']; code?: string; dispose?: () => void; error: string | null; exposed?: unknown }
const ID = /^[a-z][a-z0-9_-]{0,39}$/;

// ES モジュールのコードを読み込む (blob: の URL から)
async function importCode(code: string): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try { return await import(/* @vite-ignore */ url); } finally { URL.revokeObjectURL(url); }
}
function check(m: unknown): AddonModule {
  const a = ((m as { default?: unknown })?.default ?? m) as AddonModule;
  if (!a || typeof a !== 'object' || typeof a.register !== 'function') throw new Error('アドオンではありません (register を持つオブジェクトを export default してください)');
  if (typeof a.id !== 'string' || !ID.test(a.id)) throw new Error('アドオンの id は、英小文字で始まる英小文字・数字・-・_ (40 文字まで) にしてください');
  if (typeof a.name !== 'string' || !a.name) throw new Error('アドオンの name (名前) がありません');
  return a;
}

export class Addons {
  // アドオン (と本体の機能) が登録したもの。元に戻す・プロジェクト・MCP・画面は、これを順に扱う
  readonly objectData = new Registry<ObjectDataDef>();
  readonly sceneData = new Registry<SceneDataDef>();
  readonly commands = new Registry<CommandDef>();
  readonly menus = new Registry<MenuDef>();
  readonly panels = new Registry<PanelDef>();
  private entries = new Map<string, Entry>();
  private sceneValues = new Map<string, unknown>(); // アドオンの場面の値 (切っても覚えておく)
  private storage: AddonStorage = memoryAddonStorage();
  private seen: string[] = [];
  started = false; // 前に有効にしていたアドオンを、有効にし終えた

  constructor(private engine: Engine) {
    for (const r of [this.menus, this.panels, this.commands]) r.events.on('changed', () => engine.ui.bump('addonsVersion'));
  }

  // 組み込みのアドオンと、インストールしたアドオンを並べ、前に有効にしていたものを有効にする
  async start(builtins: AddonModule[], storage: AddonStorage = localAddonStorage()) {
    this.storage = storage;
    for (const m of builtins) this.add(m, 'builtin');
    const saved = storage.load();
    for (const [id, code] of Object.entries(saved.installed)) {
      try { this.add(check(await importCode(code)), 'installed', code); } catch (err) {
        console.error(err);
        this.engine.ui.toast(`アドオン ${id} を読み込めませんでした: ${errorText(err)}`, 8000);
      }
    }
    // 前に有効にしていたものと、初めて見る組み込みの「最初から有効」のもの
    this.seen = saved.seen ?? [];
    const first = builtins.filter(m => m.enabledByDefault && !this.seen.includes(m.id)).map(m => m.id);
    for (const id of new Set([...saved.enabled, ...first])) if (this.entries.has(id)) await this.enable(id, false);
    this.seen = [...new Set([...this.seen, ...builtins.map(m => m.id)])];
    this.save();
    this.started = true;
    this.publish();
  }
  // アドオンが出した窓口 (有効なときだけ)
  exposed<T = unknown>(id: string): T | undefined {
    const e = this.entries.get(id);
    return e?.dispose ? e.exposed as T : undefined;
  }

  list(): AddonInfo[] {
    return [...this.entries.values()].map(({ module: m, source, dispose, error }) => ({
      id: m.id, name: m.name, version: m.version ?? '', author: m.author ?? '', description: m.description ?? '', category: m.category ?? '',
      source, enabled: !!dispose, enabledByDefault: !!m.enabledByDefault, error, contributes: this.contributions(m.id),
    }));
  }
  private contributions(id: string): AddonContributions {
    const mine = <T extends { key: string; source?: string }>(r: Registry<T>) => r.list().filter(x => x.source === id || x.key.startsWith(`${id}.`));
    return {
      menus: mine(this.menus).map(m => ({ menu: m.menu, label: m.label })),
      panels: mine(this.panels).map(p => ({ tab: p.tab, title: p.title })),
      commands: mine(this.commands).map(c => c.key),
      objectData: mine(this.objectData).map(d => d.label),
      sceneData: mine(this.sceneData).map(d => d.label),
    };
  }
  // インストールしたアドオンのコードを、ファイルとして保存する
  exportCode(id: string) {
    const e = this.entries.get(id);
    if (!e?.code) throw new Error('インストールしたアドオンではありません');
    download(new TextEncoder().encode(e.code), `${id}.js`, 'text/javascript');
  }
  isEnabled(id: string) { return !!this.entries.get(id)?.dispose; }

  // アドオンを一覧に足す (有効にはしない)
  add(module: AddonModule, source: AddonInfo['source'] = 'builtin', code?: string) {
    const m = check(module);
    if (this.entries.has(m.id)) throw new Error(`アドオン ${m.id} はもうあります`);
    this.entries.set(m.id, { module: m, source, code, error: null });
    this.publish();
    return m.id;
  }

  // ファイル (ES モジュールのコード) からインストールして、有効にする。同じ id のインストールしたものは入れ替える
  async install(code: string) {
    const m = check(await importCode(code));
    const old = this.entries.get(m.id);
    if (old?.source === 'builtin') throw new Error(`${m.id} は組み込みのアドオンと同じ id です`);
    if (old) this.remove(m.id);
    this.add(m, 'installed', code);
    await this.enable(m.id);
    return m.id;
  }
  // インストールしたアドオンを消す
  uninstall(id: string) {
    const e = this.entries.get(id);
    if (!e) throw new Error(`アドオン ${id} はありません`);
    if (e.source === 'builtin') throw new Error('組み込みのアドオンは消せません (切ることはできます)');
    this.remove(id);
    this.save();
    this.publish();
  }
  private remove(id: string) {
    this.disable(id, false);
    this.entries.delete(id);
  }

  async enable(id: string, remember = true) {
    const e = this.entries.get(id);
    if (!e) throw new Error(`アドオン ${id} はありません`);
    if (e.dispose) return;
    const disposers: (() => void)[] = [];
    const api = this.api(e.module.id, disposers, v => { e.exposed = v; });
    try {
      const r = await e.module.register(api);
      if (typeof r === 'function') disposers.push(r);
      e.dispose = () => {
        e.exposed = undefined;
        for (const d of disposers.reverse()) { try { d(); } catch (err) { console.error(err); } }
        try { e.module.unregister?.(api); } catch (err) { console.error(err); }
      };
      e.error = null;
    } catch (err) {
      for (const d of disposers.reverse()) { try { d(); } catch { /* (外せるものだけ外す) */ } }
      console.error(err);
      e.error = errorText(err);
      this.engine.ui.toast(`アドオン「${e.module.name}」を有効にできませんでした: ${e.error}`, 8000);
    }
    if (remember) this.save();
    this.publish();
    this.engine.viewport.requestDraw();
  }
  disable(id: string, remember = true) {
    const e = this.entries.get(id);
    if (!e?.dispose) return;
    const d = e.dispose;
    e.dispose = undefined;
    d();
    if (remember) this.save();
    this.publish();
    this.engine.selection.publish();
    this.engine.viewport.requestDraw();
  }

  private save() {
    const enabled = [...this.entries.values()].filter(e => e.dispose).map(e => e.module.id);
    const installed = Object.fromEntries([...this.entries.values()].filter(e => e.source === 'installed').map(e => [e.module.id, e.code!]));
    this.storage.save({ enabled, installed, seen: this.seen });
  }
  private publish() { this.engine.ui.set({ addons: this.list() }); }

  // アドオン id の窓口 (足したものは disposers に入れておき、切ったときに外す)
  private api(id: string, disposers: (() => void)[], expose: (v: unknown) => void): AddonApi {
    const e = this.engine, { ui, viewport } = e;
    const track = (d: () => void) => { disposers.push(d); return d; };
    const full = (key: string) => `${id}.${key}`;
    let n = 0;
    const refresh = () => ui.bump('addonsVersion');
    const changed = () => { e.history.soon(); refresh(); viewport.requestDraw(); };
    return {
      id, engine: e, THREE,
      toast: (text, ms) => ui.toast(text, ms),
      requestDraw: () => viewport.requestDraw(),
      refresh,
      expose,
      addCommand: (name, def) => track(this.commands.add({
        key: full(name), source: id, description: def.description, params: def.params,
        run: (_e, p) => def.run((p ?? {}) as Record<string, unknown>),
      })),
      addMenuItem: def => track(this.menus.add({ ...def, key: full(`menu${++n}`), source: id })),
      addPanel: def => track(this.panels.add({ ...def, tab: def.tab ?? 'object', key: full(`panel${++n}`), source: id })),
      addObjectData: def => {
        type T = Parameters<NonNullable<typeof def.apply>>[1];
        const key = full(def.key);
        const put = (obj: Obj, v: T | null) => {
          if (v === null || v === undefined) { if (obj.addonData) delete obj.addonData[key]; } else (obj.addonData ??= {})[key] = v;
          def.apply?.(obj, v ?? null);
        };
        track(this.objectData.add({ key, aliases: def.aliases, label: def.label, get: o => (o.addonData?.[key] as T | undefined) ?? null, set: put, normalize: def.normalize }));
        // 値を持っている物 (切る前に付けた) に当て直し、切るときは外す (値は残す)
        const withValue = () => e.world.objects.filter(o => o.addonData?.[key] !== undefined);
        if (def.apply) {
          for (const o of withValue()) def.apply(o, o.addonData![key] as T);
          track(() => { for (const o of withValue()) def.apply!(o, null); });
        }
        return {
          get: obj => (obj.addonData?.[key] as T | undefined) ?? null,
          set: (obj, v) => { put(obj, v); changed(); },
        };
      },
      addSceneData: def => {
        type T = typeof def.default;
        const key = full(def.key);
        const get = () => (this.sceneValues.has(key) ? this.sceneValues.get(key) as T : structuredClone(def.default));
        const put = (v: T) => { this.sceneValues.set(key, v); def.apply?.(v); refresh(); };
        track(this.sceneData.add({
          key, label: def.label, history: def.history ?? true, save: get,
          load: raw => put(raw === undefined ? structuredClone(def.default) : def.normalize ? def.normalize(raw) : raw as T),
          reset: () => put(structuredClone(def.default)),
        }));
        if (this.sceneValues.has(key)) def.apply?.(get()); // (切る前の値を当て直す)
        return { get, set: v => { put(v); changed(); } };
      },
      onFrame: (update, active) => {
        const off = track(viewport.addSystem({ active: active ?? (() => true), update }));
        viewport.startTicking();
        return off;
      },
      onBeforeRender: fn => track(viewport.onBeforeRender(fn)),
    };
  }
}
