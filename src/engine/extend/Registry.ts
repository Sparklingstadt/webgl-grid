import { Emitter } from '../../core/events';
import type { Engine } from '../Engine';
import type { SelInfo } from '../UiChannel';
import type { Any, Obj } from '../types';

// --- 拡張の登録先: 物の設定・場面の設定・外から使える操作 ---
// 元に戻す (History)・プロジェクト (ProjectIO)・MCP (commands) は、ここに登録されたものを順に扱う。
// 組み込みの機能 (クローナー・デフォーマ・ライト・シーン・出力) も、アドオンも、同じように登録する

// 物ごとの設定 (クローナー・デフォーマ・ライトなど)。プロジェクトでは物のデータの key に、そのまま入れる
export interface ObjectTrait<T = Any> {
  key: string;
  label: string;                        // 元に戻すの名前 (「元に戻す: クローナー」)
  get(obj: Obj): T | null | undefined;
  set(obj: Obj, value: T | null): void; // 開いた・元に戻したときに当てる (null はなし)
  normalize?(raw: unknown): T | null;   // 保存されていた値を、使える値にそろえる
}
// 場面全体の設定 (シーン・出力など)。プロジェクトではデータの key に入れる
export interface StatePart<T = Any> {
  key: string;
  label: string;
  history?: boolean;          // 元に戻すの対象にする
  save(): T;
  load(raw: T | undefined): void; // 開いた・元に戻した (undefined: 保存されていない (古いプロジェクト))
  reset?(): void;             // ファイル > 最初の状態に戻す
}
// 外 (MCP) から使える操作。params は引数の説明 (名前 → 説明)
export interface CommandDef {
  key: string;
  run(e: Engine, params: Any): unknown;
  description?: string;
  params?: Record<string, string>;
  source?: string; // 登録したアドオンの id (組み込みはなし)
}

// メニューの項目 (メニューの最後に足す)
export type MenuId = 'file' | 'edit' | 'render' | 'view' | 'add' | 'object';
export interface MenuDef {
  key: string;
  menu: MenuId;
  label: string;
  run(): void;
  enabled?(): boolean;
  source?: string;
}
// サイドバーのパネル。tab は組み込みのタブ (object・material・morph・bone・scene・fx・output) か、新しいタブの名前。
// 中身は、設定の一覧 (props: アプリの部品で描く) か、自分で描く (draw: 要素を渡す。片付ける関数を返してよい)
export type PropDef =
  | { type: 'number'; label: string; get(): number; set(v: number): void; min?: number; max?: number; step?: number; digits?: number; unit?: string }
  | { type: 'boolean'; label: string; get(): boolean; set(v: boolean): void }
  | { type: 'select'; label: string; options: { value: string; label: string }[]; get(): string; set(v: string): void }
  | { type: 'color'; label: string; get(): string; set(v: string): void } // "#rrggbb"
  | { type: 'button'; label: string; run(): void }
  | { type: 'text'; text: string };
export interface PanelDef {
  key: string;
  title: string;
  tab: string;
  poll?(sel: SelInfo | null): boolean; // 出すかどうか (選んでいる物で)
  props?(): PropDef[];
  draw?(el: HTMLElement): void | (() => void);
  source?: string;
}

// 名前 (key) で引ける、登録した順の一覧。add は、外すための関数を返す
export class Registry<T extends { key: string }> {
  private items = new Map<string, T>();
  readonly events = new Emitter<{ changed: [] }>();

  add(item: T): () => void {
    if (this.items.has(item.key)) throw new Error(`${item.key} はもう登録されています`);
    this.items.set(item.key, item);
    this.events.emit('changed');
    return () => {
      if (this.items.get(item.key) !== item) return;
      this.items.delete(item.key);
      this.events.emit('changed');
    };
  }
  get(key: string) { return this.items.get(key); }
  has(key: string) { return this.items.has(key); }
  list() { return [...this.items.values()]; }
}

export class Extensions {
  readonly traits = new Registry<ObjectTrait>();
  readonly parts = new Registry<StatePart>();
  readonly commands = new Registry<CommandDef>();
  readonly menus = new Registry<MenuDef>();
  readonly panels = new Registry<PanelDef>();
}

// 値が違うときだけ当てる (同じ値で作り直さない)
export const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function applyTrait(t: ObjectTrait, obj: Obj, raw: unknown) {
  const v = raw === undefined || raw === null ? null : t.normalize ? t.normalize(raw) : structuredClone(raw);
  if (!same(t.get(obj), v)) t.set(obj, v);
}
