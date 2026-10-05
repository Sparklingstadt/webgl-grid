import type * as THREE from 'three';
import { errorText } from '../../core/errors';
import { getLang, t } from '../../core/i18n';
import { ACCESSORY_DEFAULTS, ACCESSORY_ITEMS, accessoryNameFor, isAccessoryItem } from '../../core/mme/accessory.ts';
import { decodeEmm, encodeEmm, matchFxPath, parseEmm, writeEmm, type EmmDoc, type EmmEntry } from '../../core/mme/emm.ts';
import { effectParams, fitParam, paramChannels, paramRange, type ParamUi } from '../../core/mme/params.ts';
import { textureRole } from '../../core/mme/semantics.ts';
import { MME_DEFAULTS, normalizeMmeObj, normalizeObjectEffects, type EffectRef, type MmeScene, type MmeSettings, type MmeStage, type ObjectEffects, type SavedSlot, type TabEffects } from '../../core/mme/settings.ts';
import { same } from '../addons/registry';
import type { Clock } from '../anim/Clock';
import type { Keyframes } from '../anim/Keyframes';
import { mmeChannel } from '../anim/mmeChannels';
import { download } from '../io/download';
import type { MaterialLibrary } from '../materials/MaterialLibrary';
import type { RenderOutput } from '../output/RenderOutput';
import type { SceneGraph } from '../render/SceneGraph';
import type { Viewport } from '../render/Viewport';
import { isModel, type Obj } from '../types';
import { STAGE_ROW_ID, type MmeEffectUi, type MmeRowUi, type MmeUiState, type MmeValuesUi, type UiChannel } from '../UiChannel';
import { nameOf } from '../world/Selection';
import type { Selection } from '../world/Selection';
import type { MmeObjects } from '../world/MmeObjects';
import type { World } from '../world/World';
import { objectName, pmxName, STAGE, stageNameOf, type DefaultsOf, type Owner } from './Assignments';
import { Controllers } from './Controllers';
import { EffectStore, findFile, type EffectFolder, type LoadedEffect } from './EffectStore';
import { MmeRenderer, type PostEffect } from './MmeRenderer';
import type { Slot } from './ScenePass';

// --- レンダーエンジン (標準 / MME 互換) の切り替えと設定。MME 互換のあいだは Viewport.drawOverride に描画を差し込む ---
export { MME_DEFAULTS, normalizeMme, type MmeSettings } from '../../core/mme/settings.ts';
const MAX_ERRORS = 20; // 画面に出すエラーの数

type AssignUi = Pick<MmeUiState, 'folders' | 'tabs' | 'rows' | 'controllers'>;

// エフェクト割当に載せる物 (ライト・カメラは描く形がないので除く)
const assignable = (o: Obj) => !o.light && !o.camera;
// フォルダの中の .fx (フォルダからの相対パス)
const fxIn = (f: EffectFolder) => [...f.text.keys()].filter(p => p.toLowerCase().endsWith('.fx')).sort();
const slotName = (s: Slot) => (s.kind === 'hide' ? 'hide' : s.effect.name);
const sameList = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
// パスのファイル名 (最後の \ か / のあと)
const fileName = (path: string) => path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1).trim();
// 一覧の文 (多ければ先の 5 つと残りの数)
const listOf = (items: string[]) => (items.length > 5 ? t('{list} ほか {n} 件', { list: items.slice(0, 5).join('・'), n: items.length - 5 }) : items.join('・'));

// 画面の「エフェクトのパラメータ」: 物 (ステージ) に当てた .fx ごとの、いまのパラメータと値 (範囲は入れ替わっていればそろえたもの)
export interface EffectParamsUi { effect: { folder: string; path: string; name: string }; params: (ParamUi & { value: number[] })[] }

// .fx のいじれるパラメータと、その MME のチャンネルの名前
function paramChannelsOf(e: LoadedEffect): { param: ParamUi; channels: string[] }[] {
  return e.result.ok ? effectParams(e.result.effect).map(param => ({ param, channels: paramChannels(e.folder.id, e.entry, param) })) : [];
}

// 割り当て all (写して変える) のタブの、物全体 (materialIndex が null) か材質を slot にする (null なら外す)
function withSlot(all: ObjectEffects, tab: string, materialIndex: number | null, slot: SavedSlot | null): ObjectEffects {
  const out: ObjectEffects = structuredClone(all);
  const effects = (out[tab] ??= {});
  if (materialIndex === null) {
    if (slot) effects.object = slot;
    else delete effects.object;
  } else {
    const materials = (effects.materials ??= {});
    if (slot) materials[materialIndex] = slot;
    else delete materials[materialIndex];
  }
  return out;
}

export interface MmeDeps {
  viewport: Viewport; graph: SceneGraph; world: World; selection: Selection; clock: Clock; library: MaterialLibrary; ui: UiChannel;
  output: RenderOutput; keyframes: Keyframes;
  mmeObjects: MmeObjects; // MME の物を置く (ポストエフェクトのアクセサリ・古いプロジェクトの値を移すとき)
  stage: () => THREE.Object3D | null; // ステージ (MMD モデル。割り当ては場面の値 stageEffects)
  edited: () => void; // 画面から物の値 (割り当て・仮のコントローラーの値) を変えた (元に戻すの手にする。自動保存は履歴の手から)
  // 元に戻すの対象にしない場面の値 (ステージの割り当て・フォルダ・設定) を変えた (自動保存する)。
  // 毎フレームの publish では呼ばない
  sceneEdited: () => void;
  checkpoint: () => void; // まだ手にしていない変化を先に 1 手にする (.emm の読み込みを、ほかの変化と混ぜずに 1 手にする)
}

export class MmeEngine {
  readonly store: EffectStore;
  readonly settings: MmeSettings = { ...MME_DEFAULTS };
  readonly renderer: MmeRenderer;
  readonly controllers: Controllers; // CONTROLOBJECT の値 (仮のコントローラーの値はコントローラーの物の値)
  // ステージの割り当てと、その .pmx のファイル名 (場面の値。元に戻すの対象にしない)。名前が違うステージ (差し替えたあと) には当てないが、
  // 名前のまま残す (元の .pmx に戻すと当たる)。別のステージには、割り当てを変えたときに置き換わる (保存するのは 1 つのステージ分)
  private stageData: MmeStage | null = null;
  // ステージに当てた .fx のパラメータの値 (場面の値。チャンネルの名前 → 値。キーフレームなし。元に戻すの対象にしない)
  private stageParams: Record<string, number> = {};
  private reported = new Set<string>(); // お知らせに出した例外の文
  private logged: string | null = null; // 続けて出ている例外の文 (コンソールに 1 回だけ書く。描けたら忘れる)
  private shown = ''; // 画面に出した状態 (JSON。同じなら知らせない)
  private changes = 0; // 割り当て・フォルダを変えた回数 (changed)
  // エフェクト割当のタブ・行と仮のコントローラーの名前・項目 (と JSON)。作ったときの元 (inputs) が変わったときだけ作り直す
  private assignInputs: unknown[] = [];
  private assignUi: AssignUi = { folders: [], tabs: [], rows: {}, controllers: [] };
  private assignJson = '';
  private foldersJson = '[]'; // assignUi.folders の JSON
  private catalog = new Map<string, string[]>();
  // 選んでいる物の MME の値の欄と JSON、その元 (物・欄に出したチャンネルの名前と、作ったときの物の値 (mmeValues) とチャンネルの数)。
  // 物か割り当ての元が変わったか、物の値 (画面・元に戻す・キーフレームで変わる) が作ったときと違うときだけ作り直す
  private valuesUi: MmeValuesUi | null = null;
  private valuesJson = 'null';
  private valuesObj: Obj | null = null;
  private valuesNames: string[] = [];
  private valuesRaw: (number | undefined)[] = [];
  private valuesChannelCount = 0;
  private openNotes: string[] = []; // 開いたときに知らせること (古いプロジェクトの移し替えで合わなかったもの。takeOpenNotes)

  constructor(private deps: MmeDeps) {
    this.store = new EffectStore(deps.ui);
    this.controllers = new Controllers({ world: deps.world, stage: deps.stage, outputting: () => deps.viewport.outputting });
    this.renderer = new MmeRenderer({
      ...deps, store: this.store, settings: this.settings, controllers: this.controllers, stageEffects: () => this.stageData,
      stageParams: () => this.stageParams,
    });
    // 前の描画 (効果の後処理) は、標準のエンジンのときに使う
    const prev = deps.viewport.drawOverride;
    deps.viewport.drawOverride = () => (this.settings.engine === 'mme' ? this.draw() || (prev?.() ?? false) : prev?.() ?? false);
    deps.output.waitReady = () => (this.settings.engine === 'mme' ? this.whenReady() : null);
    this.store.events.on('changed', () => this.changed());
    // (物の割り当ては物に残す (元に戻すと戻る)。その物だけが使っていた .fx の資源と、そのモデルのトゥーンの画像を捨てる)
    deps.world.events.on('removed', () => this.renderer.prune());
    deps.selection.events.on('changed', () => this.publish());
    // キーフレームで MME の値 (仮のコントローラー・アクセサリ・パラメータ) が変わった (再生・フレームを動かした): 画面の値を並べ直して描き直す
    deps.keyframes.events.on('mmeChanged', () => { this.publish(); deps.viewport.requestDraw(); });
    this.publish();
  }

  // 変えたら描き直す。標準に戻したら、MME の資源 (GPU のものと変形した形) を片付ける
  set(patch: Partial<MmeSettings>): void {
    const was = this.settings.engine;
    const before = JSON.stringify(this.settings);
    Object.assign(this.settings, patch);
    if (JSON.stringify(this.settings) !== before) this.deps.sceneEdited();
    if (was === 'mme' && this.settings.engine !== 'mme') this.renderer.dispose();
    this.publish();
    this.deps.viewport.requestDraw();
  }

  // 仮のコントローラーの項目の値 (0〜1 に収める) を、その名前のコントローラーの物 (CONTROLOBJECT が読む物) に書いて描き直す。
  // 項目は物の MME のチャンネルにする (キーを打てる)。物の値なので元に戻すの手になる。物がなければ何もしない (勝手には置かない)
  setControl(name: string, item: string, v: number): void {
    const obj = this.controllers.controller(name);
    if (!obj) return;
    this.writeControl(obj, item, v);
    this.deps.edited();
    this.publish();
    this.deps.viewport.requestDraw();
  }

  // 描いているエフェクトが読む仮のコントローラーのうち、場面に物がない名前と項目 (名前の順。画面の「置く」の元。アクセサリの名前 (.x) は除く)
  missingControllers(): { name: string; items: string[] }[] {
    return [...this.catalog].filter(([name]) => !this.controllers.controller(name)).map(([name, items]) => ({ name, items })).sort(byName);
  }

  // MME の物 obj の値 item を書いて描き直す (画面の「MME」のページ)。コントローラーは項目 (0〜1 に収める)、アクセサリは X〜Tr
  // (Rx〜Rz は度。Si は 0 以上、Tr は 0〜1 に収める)。項目は物の MME のチャンネルにする (キーを打てる)。物の値なので元に戻すの手になる。
  // MME の物でない・アクセサリの項目でない・数でなければ何もしない
  setItem(obj: Obj, item: string, v: number): void {
    const kind = obj.mmeObj?.kind;
    if (!kind || !Number.isFinite(v)) return;
    if (kind === 'controller') this.writeControl(obj, item, v);
    else if (isAccessoryItem(item)) {
      mmeChannel(obj, item);
      (obj.mmeValues ??= {})[item] = item === 'Tr' ? Math.min(Math.max(v, 0), 1) : item === 'Si' ? Math.max(v, 0) : v;
    } else return;
    this.deps.edited();
    this.publish();
    this.deps.viewport.requestDraw();
  }

  // 物の MME の値 (names: チャンネルの名前) のどれかに、フレーム frame (省けばいまのフレーム) のキーがある
  hasKey(obj: Obj, names: readonly string[], frame = this.deps.clock.frame): boolean {
    const mme = obj.anim?.mme;
    if (!mme?.size) return false;
    return names.some(name => {
      const i = obj.mmeChannels?.indexOf(name) ?? -1;
      return i >= 0 && !!mme.get(i)?.has(frame);
    });
  }

  // 画面の ◆: いまのフレームに values (チャンネルの名前 → 画面に出している値) のどれかのキーがあれば、それらのキーを消す。
  // なければ、物に値のないチャンネルに画面の値を入れてから (パラメータを変えていなければ初期値)、全部のキーを打つ
  toggleKey(obj: Obj, values: Readonly<Record<string, number>>): void {
    const names = Object.keys(values);
    const { clock, keyframes } = this.deps;
    const frame = clock.frame;
    if (!this.hasKey(obj, names, frame)) {
      this.keyValues(obj, frame, values);
      return;
    }
    for (const name of names) {
      if (this.hasKey(obj, [name], frame)) keyframes.deleteAt(obj, frame, clock.t, { kind: 'mme', index: mmeChannel(obj, name) });
    }
  }

  // MME の物 (選んでいる物の I) の、MME の値の欄に出す値の全部を、フレーム frame のキーにする (値のないものは、欄に出す値を入れてから)
  insertKeys(obj: Obj, frame: number): void {
    const v = this.valuesOf(obj);
    if (!v) return;
    const values: Record<string, number> = {};
    for (const item of v.items) values[item.name] = item.value;
    for (const { params } of v.effects) for (const p of params) p.channels.forEach((ch, i) => { values[ch] = p.value[i]; });
    if (Object.keys(values).length === 0) this.deps.ui.toast(t('キーを打つ MME の値がありません'));
    else this.keyValues(obj, frame, values);
  }

  // 値のないチャンネルに values の値を入れて、全部をフレームのキーにする (後ろのフレームなら、終わりのフレームを延ばす)
  private keyValues(obj: Obj, frame: number, values: Readonly<Record<string, number>>): void {
    const own = (obj.mmeValues ??= {});
    for (const [name, v] of Object.entries(values)) {
      if (own[name] !== undefined) continue;
      mmeChannel(obj, name);
      own[name] = v;
    }
    this.deps.keyframes.insertMme(obj, frame, Object.keys(values));
    const { clock } = this.deps;
    if (frame > clock.end) clock.setRange(clock.start, frame);
    this.publish();
  }

  // .fx (フォルダの id とその中のパス) のパラメータ name の値を、物 (その .fx を当てた物。ポストエフェクトはアクセサリ) かステージに
  // 書いて描き直す。値は範囲に収め、成分ごとの MME のチャンネル (`<フォルダの id>/<.fx のパス>:<名前>`。ベクトルは :x〜:w) にする。
  // 物の値はチャンネルを足し (キーを打てる)、元に戻すの手になる。ステージの値は場面の値 (キーフレームなし。元に戻すの対象にしない)。
  // .fx・パラメータが見つからなければ何もしない。values の足りない成分は変えない (数でない成分は初期値)
  setParam(target: Obj | 'stage', folderId: string, path: string, name: string, values: number[]): void {
    const e = this.effectAt(folderId, path);
    const found = e ? paramChannelsOf(e).find(x => x.param.name === name) : undefined;
    if (!found || values.length === 0) return;
    const { param, channels } = found;
    // (ステージに別の名前の割り当てが残っているときは、その .fx はいまのステージに当たっていないので値を置かない)
    if (target === 'stage' && this.stageData && !this.activeStage()) return;
    const store = target === 'stage' ? this.stageParams : (target.mmeValues ??= {});
    const next = fitParam(param, channels.map((ch, i) => (i < values.length ? values[i] : store[ch] ?? param.init[i])));
    for (let i = 0; i < Math.min(values.length, channels.length); i++) {
      if (target !== 'stage') mmeChannel(target, channels[i]);
      store[channels[i]] = next[i];
    }
    if (target === 'stage') this.deps.sceneEdited();
    else this.deps.edited();
    this.publish();
    this.deps.viewport.requestDraw();
  }

  // 物 (ステージ) に当てた .fx ごとの、いまのパラメータと値 (画面の「エフェクトのパラメータ」)。.fx は全部のタブの割り当てで見つかって
  // コンパイルできたもの (同じものは 1 つ)。アクセサリはポストエフェクト (Main の物の割り当て) だけ、コントローラーは描かないのでなし。
  // .fx を読み直して消えたパラメータは出さない (物の古いチャンネルとキーは残す)。値は描くときと同じ (範囲に収める。値がなければ初期値)
  paramsOf(target: Obj | 'stage'): EffectParamsUi[] {
    const { assignments } = this.renderer;
    let effects: LoadedEffect[];
    if (target === 'stage') effects = assignments.referencedStage(stageNameOf(this.deps.stage()));
    else if (!target.mmeObj) effects = assignments.referenced(target);
    else {
      const saved = target.mmeObj.kind === 'accessory' ? target.mme?.Main?.object : undefined;
      const post = saved && saved !== 'hide' ? assignments.effectOf(saved) : null;
      effects = post ? [post] : [];
    }
    const values: Readonly<Record<string, number>> = (target === 'stage' ? this.stageParams : target.mmeValues) ?? {};
    return effects.filter(e => e.result.ok).map(e => ({
      effect: { folder: e.folder.id, path: e.entry, name: e.name },
      params: paramChannelsOf(e).map(({ param, channels }) => {
        const [min, max] = paramRange(param);
        return { ...param, min, max, value: fitParam(param, channels.map((ch, i) => values[ch] ?? param.init[i])) };
      }),
    }));
  }

  // フォルダの中の .fx (パスは大文字小文字と '\' を問わない)。フォルダかファイルがなければ null
  private effectAt(folderId: string, path: string): LoadedEffect | null {
    const folder = this.store.folder(folderId);
    const file = folder && findFile(folder, path);
    return folder && file ? this.store.effect(folder, file) : null;
  }

  private writeControl(obj: Obj, item: string, v: number): void {
    mmeChannel(obj, item);
    (obj.mmeValues ??= {})[item] = Number.isNaN(v) ? 0 : Math.min(Math.max(v, 0), 1);
  }

  // 割り当て・フォルダが変わった: 使わなくなった資源を捨てて、画面に知らせて描き直す (自動保存もする)
  private changed(): void {
    this.changes++;
    this.deps.sceneEdited();
    this.renderer.prune();
    this.publish();
    this.deps.viewport.requestDraw();
  }

  // 画面に設定・選んでいる物の .fx (Main の物の割り当て)・ポストエフェクト (アクセサリの物。隠したものも。オンはビューポートでも
  // 書き出しでも隠していないもの)・エフェクト割当のタブと行・仮のコントローラー・選んでいる物の MME の値の欄を知らせる
  // (変わったときだけ)。毎フレーム呼ばれるので、割り当ての行と仮のコントローラーは元 (inputs) が変わったときだけ作り、
  // 値の欄は、それに加えて選んでいる物が変わったか、物の値が変わったときだけ作る。どちらも JSON を使い回す
  publish(): void {
    const saved = this.deps.selection.current?.mme?.Main?.object;
    // (見つからない .fx はコンパイルしない: コンパイルできないお知らせを出さない。見つからないことは描くときに警告する)
    const fx = saved && saved !== 'hide' ? this.renderer.assignments.effectOf(saved) : null;
    const rest: Omit<MmeUiState, keyof AssignUi | 'values'> = {
      settings: { ...this.settings },
      object: fx ? this.effectUi(fx) : null,
      posts: this.renderer.posts('all').map(({ obj, effect }) => ({
        ...this.effectUi(effect), enabled: !obj.hidden && !obj.colHidden && !obj.hideRender, objId: obj.id, accessory: objectName(obj),
      })),
      warnings: [...this.renderer.warnings],
    };
    const tabs = [{ name: 'Main', description: '' }, ...this.renderer.offscreenTabs().filter(x => x.name !== 'Main')];
    const inputs = this.inputs(tabs);
    const rebuilt = !sameList(inputs, this.assignInputs);
    if (rebuilt) {
      this.assignInputs = inputs;
      this.rebuild(tabs);
    }
    const current = this.deps.selection.current;
    const target = current && (current.mmeObj || isModel(current)) ? current : null;
    if (rebuilt || target !== this.valuesObj || this.valuesChanged()) this.rebuildValues(target);
    const json = `${JSON.stringify(rest)}\n${this.assignJson}\n${this.valuesJson}`;
    if (json === this.shown) return;
    this.shown = json;
    this.deps.ui.set({ mme: { ...rest, ...this.assignUi, values: this.valuesUi } });
  }

  // 値の欄に出した物の値 (mmeValues) かチャンネルの数が、作ったときと違う (毎フレーム呼ぶので、作らずに比べる)
  private valuesChanged(): boolean {
    const obj = this.valuesObj;
    if (!obj) return false;
    const own = obj.mmeValues;
    return (obj.mmeChannels?.length ?? 0) !== this.valuesChannelCount || this.valuesNames.some((name, i) => own?.[name] !== this.valuesRaw[i]);
  }

  private rebuildValues(obj: Obj | null): void {
    this.valuesObj = obj;
    this.valuesUi = obj && this.valuesOf(obj);
    this.valuesNames = this.valuesUi ? [...this.valuesUi.items.map(x => x.name), ...this.valuesUi.effects.flatMap(e => e.params.flatMap(p => p.channels))] : [];
    this.valuesRaw = this.valuesNames.map(name => obj?.mmeValues?.[name]);
    this.valuesChannelCount = obj?.mmeChannels?.length ?? 0;
    this.valuesJson = JSON.stringify(this.valuesUi);
  }

  // MME の値の欄: コントローラーの物は項目 (描いているエフェクトがその物の名前で読む項目と、物のチャンネル。値がなければ 0)、
  // アクセサリの物は X〜Tr (値がなければ MMD の既定)、MMD モデルは項目なし。どれにも当てた .fx ごとのパラメータ (paramsOf)。ほかの物は null
  private valuesOf(obj: Obj): MmeValuesUi | null {
    const kind = obj.mmeObj?.kind ?? (isModel(obj) ? 'model' : null);
    if (!kind) return null;
    const own = obj.mmeValues ?? {};
    let items: MmeValuesUi['items'] = [];
    if (kind === 'accessory') items = ACCESSORY_ITEMS.map(name => ({ name, value: own[name] ?? ACCESSORY_DEFAULTS[name] }));
    else if (kind === 'controller') {
      const names = new Set<string>();
      for (const [name, list] of this.catalog) if (this.controllers.controller(name) === obj) for (const item of list) names.add(item);
      for (const name of obj.mmeChannels ?? []) names.add(name);
      items = [...names].map(name => ({ name, value: own[name] ?? 0 }));
    }
    const effects = this.paramsOf(obj).map(({ effect, params }) => ({
      effect, params: params.map(p => ({ ...p, channels: paramChannels(effect.folder, effect.path, p) })),
    }));
    return { objId: obj.id, kind, items, effects };
  }

  // 割り当ての行と仮のコントローラーの項目の元。物の数によらず、版の数 (言語・フォルダ・割り当て・場面の物 (足す・消す・名前・隠す・
  // 並び・ステージ)・マテリアル) と、前のフレームのオフスクリーンのタブ (名前・説明・DefaultEffect の規則 (宣言ごとに同じ配列)・持ち主) と、
  // GPU で止めたエフェクト。中身は参照で比べる
  private inputs(tabs: { name: string; description: string }[]): unknown[] {
    const ui = this.deps.ui.state;
    const out: unknown[] = [getLang(), this.store.version, this.changes, ui.sceneVersion, ui.materialsVersion];
    for (const tab of tabs) {
      const d = tab.name === 'Main' ? null : this.renderer.offscreenDefaults(tab.name);
      out.push(tab.name, tab.description, d?.defaults.rules ?? null, d?.defaults.base ?? null, d?.defaults.folder ?? null, ...(d?.owners ?? []), '|');
    }
    out.push(...this.renderer.stoppedEffects());
    return out;
  }

  // エフェクト割当 (タブ・タブごとのステージと物と材質の行・フォルダの .fx) と、仮のコントローラーの名前と項目 (描いているエフェクトが読む、
  // 場面にない名前とコントローラーの物がある名前。名前の順) を作る
  private rebuild(tabs: { name: string; description: string }[]): void {
    const objects = this.deps.world.objects.filter(assignable);
    const stage = this.stageMesh();
    const rows: Record<string, MmeRowUi[]> = {};
    for (const tab of tabs) {
      const d = tab.name === 'Main' ? { defaults: null, owners: new Set<Owner>() } : this.renderer.offscreenDefaults(tab.name);
      if (!d) continue;
      rows[tab.name] = [
        ...(stage ? this.stageRows(stage, tab.name, d.defaults, d.owners.has(STAGE)) : []),
        ...objects.flatMap(o => this.rowsOf(o, tab.name, d.defaults, d.owners.has(o))),
      ];
    }
    this.catalog = this.controllers.catalog(this.renderer.drawnEffects());
    const controllers = [...this.catalog].map(([name, items]) => ({ name, items, objId: this.controllers.controller(name)?.id ?? null })).sort(byName);
    // (フォルダの一覧は、変わらなければ同じ配列を渡す: 画面は一覧が変わったときだけ選択肢を作る)
    const folders = this.store.folders().map(f => ({ id: f.id, name: f.name, fx: fxIn(f) }));
    const foldersJson = JSON.stringify(folders);
    if (foldersJson !== this.foldersJson) {
      this.foldersJson = foldersJson;
      this.assignUi.folders = folders;
    }
    this.assignUi = { folders: this.assignUi.folders, tabs, rows, controllers };
    this.assignJson = JSON.stringify(this.assignUi);
  }

  // 物の行と、MMD モデルなら材質の行
  private rowsOf(obj: Obj, tab: string, defaults: DefaultsOf | null, isOwner: boolean): MmeRowUi[] {
    const { assignments } = this.renderer;
    const fallback = (material: number | null) => assignments.fallbackFor(tab, defaults, obj, material, isOwner);
    return this.rows(obj.id, nameOf(obj), isModel(obj) ? this.materialNames(obj.model) : [], obj.mme?.[tab], defaults, fallback);
  }

  // ステージの行と材質の行 (名前は「ステージ: .pmx のファイル名」)
  private stageRows(mesh: THREE.SkinnedMesh, tab: string, defaults: DefaultsOf | null, isOwner: boolean): MmeRowUi[] {
    const name = pmxName(mesh) ?? '';
    const fallback = (material: number | null) => this.renderer.assignments.stageFallbackFor(tab, defaults, name, material, isOwner);
    const label = t('ステージ: {name}', { name: name || t('ステージ') });
    return this.rows(STAGE_ROW_ID, label, this.materialNames(mesh), this.renderer.assignments.stageEffectsFor(name)?.[tab], defaults, fallback);
  }

  // 1 つの物の行と材質の行。既定の欄は Assignments の決め方 (割り当てがないときに描くもの)。
  // GPU で止めたエフェクトは、描くときと同じく Main では default.fx、オフスクリーンでは描かない (hide) にして、止めたことを行に書く
  private rows(
    objId: number, label: string, materials: string[], effects: TabEffects | undefined, defaults: DefaultsOf | null, fallbackFor: (material: number | null) => Slot,
  ): MmeRowUi[] {
    const { assignments } = this.renderer;
    const stoppedIn = (e: LoadedEffect | null) => (e && e.result.ok && this.renderer.stopped(e) ? e.name : null);
    const row = (label: string, material: number | null, saved: SavedSlot | undefined): MmeRowUi => {
      const slot = fallbackFor(material);
      const fallbackStopped = slot.kind === 'effect' ? stoppedIn(slot.effect) : null;
      const fallback = fallbackStopped ? (defaults ? 'hide' : this.store.defaultEffect.name) : slotName(slot);
      const stopped = saved === undefined ? fallbackStopped : saved === 'hide' ? null : stoppedIn(assignments.effectOf(saved));
      return { objId, label, material, assigned: this.savedName(saved), assignedRef: this.savedRef(saved), fallback, stopped };
    };
    return [
      row(label, null, effects?.object),
      ...materials.map((name, i) => row(name || t('材質 {n}', { n: i }), i, effects?.materials?.[i])),
    ];
  }

  // ステージのモデル (最初の SkinnedMesh。ステージがない・読み込み中なら null)
  private stageMesh(): THREE.SkinnedMesh | null {
    let mesh: THREE.SkinnedMesh | null = null;
    this.deps.stage()?.traverse(o => { if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh; });
    return mesh;
  }

  // MMD モデルの材質の名前 (材質の番号の順。マテリアルの名前、なければ three.js の材質の名前)
  private materialNames(mesh: THREE.Mesh): string[] {
    const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
    return (Array.isArray(m) ? m : m ? [m] : []).map(x => this.deps.library.materials.get(x.userData.materialId)?.name || x.name);
  }

  // 割り当ての参照 (選択を照らす id。パスはフォルダの中で見つかればその書き方 = 選択肢のパス)
  private savedRef(saved: SavedSlot | undefined): MmeRowUi['assignedRef'] {
    if (saved === undefined) return null;
    if (saved === 'hide') return 'hide';
    const folder = this.store.folder(saved.folder);
    return { folder: saved.folder, path: (folder && findFile(folder, saved.path)) ?? saved.path };
  }

  // 割り当ての名前 ("フォルダ名/パス"・'hide'。パスはフォルダの中で見つかればその書き方)
  private savedName(saved: SavedSlot | undefined): string | null {
    if (saved === undefined) return null;
    if (saved === 'hide') return 'hide';
    const folder = this.store.folder(saved.folder);
    const path = (folder && findFile(folder, saved.path)) ?? saved.path;
    return folder?.name ? `${folder.name}/${path}` : path;
  }

  // コンパイルの結果と警告 (コンパイラの警告のあとに、描いたときのそのエフェクトの警告。GPU で止めたらそのことも)
  private effectUi(e: LoadedEffect): MmeEffectUi {
    const r = e.result;
    const errors = r.ok ? [] : r.errors.slice(0, MAX_ERRORS).map(d => ({ code: d.code, where: `${d.file}:${d.line}`, message: d.message }));
    const warnings = [...r.warnings.map(d => `${d.file}:${d.line} ${d.message}`), ...this.renderer.warningsOf(e)];
    if (this.renderer.stopped(e)) warnings.push(t('GPU で使えないので止めました'));
    return { id: e.id, name: e.name, ok: r.ok, errors, errorCount: r.ok ? 0 : r.errors.length, warnings };
  }

  // .fx が入っているフォルダを読み込んで (同じ名前のフォルダにはまとめて)、その .fx をコンパイルする (失敗したらお知らせを出す)
  async loadEffect(files: File[], entry: string): Promise<LoadedEffect> {
    const folder = await this.store.addFolder(files);
    const e = this.store.effect(folder, entry);
    this.publish(); // (フォルダの .fx の一覧)
    return e;
  }

  // 物の割り当てを置き換える (物の値 'mme' を開いた・元に戻した・複製したとき。null はなし)
  setObjectEffects(obj: Obj, v: ObjectEffects | null): void {
    obj.mme = v ?? undefined;
    this.changed();
  }

  // 物のタブの、物全体 (materialIndex が null) か材質の割り当てを変える (slot が null なら外して既定に戻す)。元に戻すの手になる
  assign(obj: Obj, tab: string, materialIndex: number | null, slot: SavedSlot | null): void {
    const next = normalizeObjectEffects(withSlot(obj.mme ?? {}, tab, materialIndex, slot));
    if (same(obj.mme ?? null, next)) return;
    this.setObjectEffects(obj, next);
    this.deps.edited();
  }

  // いまのステージ (.pmx のファイル名が合うもの) に当たっている割り当て。ステージがない・名前が違うなら null
  activeStage(): ObjectEffects | null {
    return this.renderer.assignments.stageEffectsFor(stageNameOf(this.deps.stage()));
  }

  // ステージのタブの、物全体 (materialIndex が null) か材質の割り当てを変える (slot が null なら外して既定に戻す)。
  // 場面の値なので、元に戻すの対象にしない。残っている割り当てが別の名前のステージのものなら、それは捨てて (パラメータの値も)
  // いまのステージの名前で置き直す (何も変わらなければ捨てない)。最後の割り当てを外したときもパラメータの値を捨てる
  assignStage(tab: string, materialIndex: number | null, slot: SavedSlot | null): void {
    const old = this.activeStage();
    const next = normalizeObjectEffects(withSlot(old ?? {}, tab, materialIndex, slot));
    if (same(old, next)) return;
    if (!next || (!old && this.stageData)) this.stageParams = {};
    this.stageData = next ? { name: stageNameOf(this.deps.stage()) ?? this.stageData?.name ?? '', effects: next } : null;
    this.changed();
  }

  // --- 画面の操作 ---
  // フォルダの中の .fx (フォルダからの相対パス)
  fxFilesIn(files: File[]): string[] {
    return EffectStore.fxFilesIn(files);
  }

  // 選んでいる物の Main に .fx を読んで当てる (コンパイルできなくても当てる。描くのは default.fx で、画面にエラーを出す)
  async loadObjectEffect(files: File[], entry: string): Promise<void> {
    const obj = this.deps.selection.current;
    if (!obj) return;
    const e = await this.read(files, entry);
    if (e && this.deps.world.objects.includes(obj)) this.assign(obj, 'Main', null, { folder: e.folder.id, path: e.entry });
  }

  removeObjectEffect(): void {
    const obj = this.deps.selection.current;
    if (obj) this.assign(obj, 'Main', null, null);
  }

  // .fx を読んで、ポストエフェクトにする (addPost)。置いたアクセサリを返す (読めない・置けなければ null)
  async addPostEffect(files: File[], entry: string): Promise<Obj | null> {
    const e = await this.read(files, entry);
    return e ? this.addPost(e) : null;
  }

  // .fx をポストエフェクトにする: アクセサリの物 (名前は .fx のファイル名の拡張子を .x にしたもの) を場面の最後 (いちばん外側) に置いて、
  // Main の物に当てる (コンパイルできなくても当てる。描かずに画面にエラーを出す)。置くのと当てるのは 1 回の取り消しで戻る。
  // 選んでいる物は変えない。画面の並べ替えは物の並べ替え、オン・オフは隠す (ビューポートでも書き出しでも)、外すはアクセサリを消す。
  // 置けなければ知らせて null
  addPost(e: LoadedEffect): Obj | null {
    if (this.deps.world.full) {
      this.deps.ui.toast(t('これ以上置けません'));
      return null;
    }
    const obj = this.deps.mmeObjects.add({ kind: 'accessory', name: accessoryNameFor(e.entry) });
    this.assign(obj, 'Main', null, { folder: e.folder.id, path: e.entry });
    return obj;
  }

  // ポストエフェクト (場面の並びのアクセサリの物と、それに当てた .fx。最後がいちばん外側)。all でなければ、いま描くときに隠しているもの
  // (書き出し中は書き出しで隠すもの) を飛ばす
  posts(all = false): PostEffect[] {
    return this.renderer.posts(all ? 'all' : 'drawn');
  }

  // エフェクトの割り当て (場面にある物 (アクセサリのポストエフェクトも) とステージの割り当て。ステージのパラメータの値も) を全部外す
  // (最初の状態に戻すとき・プロジェクトを開くとき)
  clearEffects(): void {
    const assigned = this.deps.world.objects.filter(o => o.mme);
    for (const obj of assigned) obj.mme = undefined;
    const stage = this.stageData !== null;
    this.stageData = null;
    this.stageParams = {};
    if (assigned.length > 0 || stage) this.changed();
  }

  // --- .emm (MME のエフェクト割当ファイル。書式は core/mme/emm.ts と docs/superpowers/notes/2026-10-05-emm-format.md) ---
  // .emm を読んで割り当てを戻す。[Object] のファイル名を、大文字小文字を無視して場面の物の名前 (objectName) とステージの .pmx の
  // ファイル名に照らす (同じ名前は .emm の番号の順に、場面の並びの順。ステージは最後)。場面にない .x はその名前の仮のアクセサリを置き、
  // ほかの合わない物は飛ばす。合った物の割り当ては .emm のものに置き換える (.show = false・hide は描かない、none は外す。
  // .fx は読み込んだフォルダで後ろの部分がいちばん長く合うもの。見つからない .fx の行の場所はいまの割り当てのままにし、見つかった行も
  // none の行もない物は変えない)。アクセサリの Main に物全体の行がなければ、MME が自動で読む
  // .x と同じ名前の .fx を当てる (見つからなくても警告しない)。物の割り当てと置いたアクセサリは 1 回の取り消しで戻る
  // (ステージの割り当ては場面の値なので戻らない)。合わない物・見つからない .fx・置けないアクセサリは警告にまとめ、お知らせにも出す
  importEmm(bytes: Uint8Array): { applied: number; warnings: string[] } {
    this.deps.checkpoint();
    const { doc, warnings } = parseEmm(decodeEmm(bytes));
    const { world, mmeObjects } = this.deps;
    type Target = Obj | typeof STAGE;
    const stageMesh = this.stageMesh();
    const stageName = stageMesh && pmxName(stageMesh);
    const pool: { name: string; target: Target }[] = [
      ...world.objects.filter(assignable).map(o => ({ name: objectName(o).toLowerCase(), target: o as Target })),
      ...(stageName ? [{ name: stageName.toLowerCase(), target: STAGE as Target }] : []),
    ];
    const targets = new Map<number, Target>();
    const missing = new Set<string>(), full = new Set<string>(); // (同じ名前は 1 つ)
    let created = false;
    for (const { index, file } of doc.objects) {
      const name = fileName(file);
      const i = pool.findIndex(c => c.name === name.toLowerCase());
      if (i >= 0) {
        targets.set(index, pool[i].target);
        pool.splice(i, 1);
        continue;
      }
      if (!/\.x$/i.test(name)) missing.add(name || file);
      else if (world.full) full.add(name);
      else {
        targets.set(index, mmeObjects.add({ kind: 'accessory', name }));
        created = true;
      }
    }

    const folders = this.store.folders().map(f => ({ id: f.id, name: f.name, files: [...f.text.keys()].filter(p => /\.fx(sub)?$/i.test(p)).sort() }));
    const next = new Map<Target, ObjectEffects>([...targets.values()].map(target => [target, {}]));
    const lost = new Set<string>();
    // (.fx が見つからなかった行の場所。そこはいまの割り当てのままにする。見つかった行・none の行が 1 つもない物は置き換えない)
    const unresolved = new Map<Target, { tab: string; material: number | null }[]>();
    const resolved = new Set<Target>();
    let applied = 0;
    const put = (target: Target, tab: string, material: number | null, slot: SavedSlot) => {
      const effects = (next.get(target)![tab] ??= {});
      if (material === null) effects.object = slot;
      else (effects.materials ??= {})[material] = slot;
      resolved.add(target);
      applied++;
    };
    for (const [tab, entries] of Object.entries(doc.tabs)) {
      for (const { object, material, value, show } of entries) {
        const target = targets.get(object);
        if (target === undefined) continue;
        if (value === 'none' && show !== false) { resolved.add(target); continue; }
        const slot = show === false || value === 'hide' ? 'hide' : matchFxPath(value, folders);
        if (slot) put(target, tab, material, slot);
        else {
          lost.add(value);
          if (!unresolved.has(target)) unresolved.set(target, []);
          unresolved.get(target)!.push({ tab, material });
        }
      }
    }
    for (const { index, file } of doc.objects) {
      const target = targets.get(index);
      if (target === undefined || target === STAGE || target.mmeObj?.kind !== 'accessory' || !/\.x$/i.test(file)) continue;
      if (doc.tabs.Main?.some(e => e.object === index && e.material === null)) continue;
      const own = matchFxPath(file.replace(/\.x$/i, '.fx'), folders);
      if (own) put(target, 'Main', null, own);
    }

    let edited = false;
    for (const [target, effects] of next) {
      const keep = unresolved.get(target) ?? [];
      if (keep.length > 0 && !resolved.has(target)) continue;
      const current = target === STAGE ? this.activeStage() : target.mme;
      for (const { tab, material } of keep) {
        const old = material === null ? current?.[tab]?.object : current?.[tab]?.materials?.[material];
        if (old === undefined) continue;
        const slots = (effects[tab] ??= {});
        if (material === null) slots.object ??= old;
        else (slots.materials ??= {})[material] ??= old;
      }
      if (target === STAGE) { this.replaceStageEffects(effects); continue; }
      const v = normalizeObjectEffects(effects);
      if (same(target.mme ?? null, v)) continue;
      target.mme = v ?? undefined;
      edited = true;
    }
    if (edited || created) this.changed();
    if (edited) this.deps.edited();

    if (missing.size) warnings.push(t('.emm の物 {names} は場面にないので、その割り当てを飛ばしました', { names: listOf([...missing]) }));
    if (full.size) warnings.push(t('.emm のアクセサリ {names} を置けなかったので、その割り当てを飛ばしました (これ以上置けません)', { names: listOf([...full]) }));
    if (lost.size) warnings.push(t('.emm の .fx {paths} は読み込んだフォルダにないので、その割り当てを飛ばしました', { paths: listOf([...lost]) }));
    // (警告の区切りも言語ごと)
    this.deps.ui.toast(
      warnings.length ? t('.emm を読みました (割り当て {n} 件。{notes})', { n: applied, notes: warnings.join(t('。')) }) : t('.emm を読みました (割り当て {n} 件)', { n: applied }),
      warnings.length ? 8000 : 4000,
    );
    return { applied, warnings };
  }

  // ステージの割り当てを effects に置き換える (assignStage で 1 つずつ。場面の値なので取り消しの対象にしない)。
  // 先に当ててから外す (途中で割り当てがなくなって、パラメータの値を捨てないように)
  private replaceStageEffects(effects: ObjectEffects): void {
    const want = normalizeObjectEffects(effects) ?? {};
    const old = this.activeStage() ?? {};
    for (const [tab, effects] of Object.entries(want)) {
      if (effects.object) this.assignStage(tab, null, effects.object);
      for (const [m, slot] of Object.entries(effects.materials ?? {})) this.assignStage(tab, Number(m), slot);
    }
    for (const [tab, slots] of Object.entries(old)) {
      if (slots.object && !want[tab]?.object) this.assignStage(tab, null, null);
      for (const m of Object.keys(slots.materials ?? {})) if (!want[tab]?.materials?.[m]) this.assignStage(tab, Number(m), null);
    }
  }

  // いまの割り当てを .emm (Shift_JIS・CRLF) にする。物は場面の並びのモデルと MME の物 (ファイル名は objectName)、最後にステージ。
  // [Effect] には全部の物の物全体の行を書く (割り当てがなければ none)。.fx は「フォルダの名前\フォルダの中のパス」。
  // オフスクリーンの Owner は、そのオフスクリーンを宣言する .fx を当てた最初の物 (Main を先に見る)
  exportEmm(): Uint8Array {
    const list: { file: string; effects: ObjectEffects | null }[] = this.deps.world.objects
      .filter(o => o.mmeObj || isModel(o))
      .map(o => ({ file: objectName(o), effects: o.mme ?? null }));
    const stageMesh = this.stageMesh();
    const stageName = stageMesh && pmxName(stageMesh);
    if (stageName) list.push({ file: stageName, effects: this.renderer.assignments.stageEffectsFor(stageName) });
    const doc: EmmDoc = { objects: list.map((x, i) => ({ index: i + 1, file: x.file })), tabs: { Main: [] } };
    const entry = (object: number, material: number | null, slot: SavedSlot): EmmEntry =>
      slot === 'hide' ? { object, material, value: 'none', show: false } : { object, material, value: this.emmPath(slot) };
    list.forEach(({ effects }, i) => {
      for (const [tab, { object, materials }] of Object.entries(effects ?? {})) {
        const entries = (doc.tabs[tab] ??= []);
        if (object) entries.push(entry(i + 1, null, object));
        for (const [m, slot] of Object.entries(materials ?? {})) entries.push(entry(i + 1, Number(m), slot));
      }
      if (!effects?.Main?.object) doc.tabs.Main.push({ object: i + 1, material: null, value: 'none' });
    });
    const owners: NonNullable<EmmDoc['owners']> = {};
    const declares = (slot: SavedSlot | undefined, name: string) => {
      const e = slot && slot !== 'hide' ? this.renderer.assignments.effectOf(slot) : null;
      return !!e?.result.ok && e.result.effect.textures.some(x => x.name === name && textureRole(x) === 'offscreen');
    };
    for (const name of Object.keys(doc.tabs).filter(x => x !== 'Main')) {
      const where = ['Main', ...Object.keys(doc.tabs).filter(x => x !== 'Main' && x !== name)];
      for (const tab of where) {
        const i = list.findIndex(({ effects }) => [effects?.[tab]?.object, ...Object.values(effects?.[tab]?.materials ?? {})].some(s => declares(s, name)));
        if (i < 0) continue;
        owners[name] = tab === 'Main' ? { object: i + 1 } : { object: i + 1, tab };
        break;
      }
    }
    if (Object.keys(owners).length) doc.owners = owners;
    return encodeEmm(writeEmm(doc));
  }

  // .emm に書く .fx のパス (フォルダの名前\フォルダの中のパス。フォルダの中で見つかればその書き方)
  private emmPath(ref: EffectRef): string {
    const folder = this.store.folder(ref.folder);
    const path = ((folder && findFile(folder, ref.path)) ?? ref.path).replace(/\//g, '\\');
    return folder?.name ? `${folder.name}\\${path}` : path;
  }

  // .emm のファイルを読んで割り当てを戻す (importEmm。読めなければお知らせ)
  async openEmm(file: File): Promise<void> {
    try {
      this.importEmm(new Uint8Array(await file.arrayBuffer()));
    } catch (err) {
      this.deps.ui.toast(t('.emm を読めませんでした: {error}', { error: errorText(err) }), 8000);
    }
  }

  // いまの割り当てを .emm にしてダウンロードさせる (名前はプロジェクトの名前)
  downloadEmm(): void {
    download(this.exportEmm(), `${this.deps.ui.state.projectName ?? t('エフェクト割当')}.emm`);
  }

  // ファイルを読めなければ (File.arrayBuffer の失敗など) お知らせを出して null
  private async read(files: File[], entry: string): Promise<LoadedEffect | null> {
    try {
      return await this.loadEffect(files, entry);
    } catch (err) {
      this.deps.ui.toast(t('.fx を読めませんでした: {error}', { error: errorText(err) }), 8000);
      return null;
    }
  }

  // --- プロジェクトの場面の値 'mme' (フォルダの中のファイルは ProjectIO が mmeFiles として持ち、開くときに EffectStore.restore で先に戻す) ---
  saveScene(): MmeScene {
    return {
      settings: { ...this.settings },
      folders: this.store.folders().map(f => ({ id: f.id, name: f.name })),
      ...(this.stageData ? { stage: structuredClone(this.stageData) } : {}),
      ...(Object.keys(this.stageParams).length > 0 ? { stageParams: { ...this.stageParams } } : {}),
    };
  }

  // 開いたプロジェクトの設定・ステージの割り当てにする (フォルダと物は戻してある)。
  // 第 4 の計画の形のポストエフェクトの並び (posts) はアクセサリの物に、仮のコントローラーの値 (controls) はコントローラーの物に移す
  loadScene(scene: MmeScene): void {
    // (第 4 の計画の形の割り当ては名前がない。プロジェクトといっしょに読み込んだステージ (物より先に読み込んである) のものとする。
    // ステージがなければ名前は '' (どのステージにも当たらないが、名前のないステージには当たる))
    this.stageData = scene.stage ? structuredClone(scene.stage)
      : scene.legacyStage ? { name: stageNameOf(this.deps.stage()) ?? '', effects: structuredClone(scene.legacyStage) } : null;
    this.stageParams = { ...scene.stageParams };
    this.openNotes = [...this.migrateControls(scene.controls ?? {}), ...this.migratePosts(scene.posts ?? [])];
    this.set(scene.settings);
  }

  // 開いたときに知らせること (ProjectIO が「開きました」のお知らせに添える)。一度読んだら忘れる
  takeOpenNotes(): string[] {
    const notes = this.openNotes;
    this.openNotes = [];
    return notes;
  }

  // 古いプロジェクトの仮のコントローラーの値を、名前ごとにその名前のコントローラーの物 (なければ置く) に入れる。合わなかったものを
  // 知らせる文 (理由ごとに 1 つ) を返す。名前は MME の物の名前にそろえ (前後の空白を除き 64 文字まで)、空になるものは移さず、
  // 変わったものは移すが .fx の名前と合わないと知らせる。名前が場面のほかの物・ステージに合う (値は使われていなかった) なら
  // 移さない (同じ絵のまま)。置けなければ移さない。名前のせいで開くのをやめることはない
  private migrateControls(controls: Record<string, Record<string, number>>): string[] {
    const empty: string[] = [], renamed: string[] = [], full: string[] = [];
    for (const [raw, items] of Object.entries(controls)) {
      const name = normalizeMmeObj({ kind: 'controller', name: raw })?.name;
      if (!name) { empty.push(JSON.stringify(raw)); continue; }
      if (name !== raw) renamed.push(JSON.stringify(raw));
      let obj = this.controllers.controller(name);
      if (!obj && this.controllers.has(name)) continue;
      if (!obj && this.deps.world.full) { full.push(name); continue; }
      try {
        obj ??= this.deps.mmeObjects.add({ kind: 'controller', name });
      } catch {
        full.push(name);
        continue;
      }
      for (const [item, v] of Object.entries(items)) this.writeControl(obj, item, v);
    }
    const names = (l: string[]) => l.join('・');
    return [
      ...(empty.length ? [t('古いプロジェクトのコントローラー {names} は名前が空なので、値を移せませんでした', { names: names(empty) })] : []),
      ...(renamed.length ? [t('古いプロジェクトのコントローラー {names} は名前を直して移したので、.fx が読む名前と合いません', { names: names(renamed) })] : []),
      ...(full.length ? [t('古いプロジェクトのコントローラー {names} の値を移せませんでした (これ以上置けません)', { names: names(full) })] : []),
    ];
  }

  // 古いプロジェクトのポストエフェクトの並びを、その順に場面の最後に置くアクセサリの物にする (名前は .fx のファイル名の拡張子を .x に
  // したもの。Main の物に当て、オフならビューポートでも書き出しでも隠す (画面のオン・オフと同じ)。同じ絵になる)。
  // フォルダがないもの (描いていなかった。開いても一覧から捨てていた) は移さない。置けなければ移さず、知らせる文を返す。開いた状態の一部なので、元に戻すの手にしない (ProjectIO がこのあと履歴を始め直す)
  private migratePosts(posts: NonNullable<MmeScene['posts']>): string[] {
    const full: string[] = [];
    for (const { effect: ref, enabled } of posts) {
      if (!this.store.folder(ref.folder)) continue;
      const name = accessoryNameFor(ref.path);
      if (this.deps.world.full) { full.push(name); continue; }
      const obj = this.deps.mmeObjects.add({ kind: 'accessory', name });
      obj.mme = { Main: { object: { folder: ref.folder, path: ref.path } } };
      if (!enabled) obj.hidden = obj.hideRender = true;
    }
    return full.length ? [t('古いプロジェクトのポストエフェクト {names} をアクセサリに移せませんでした (これ以上置けません)', { names: full.join('・') })] : [];
  }

  // 最初の状態に戻す: 割り当てとパラメータの値 (ステージのものも)・読み込んだフォルダを消し、既定の設定にする
  // (ポストエフェクトのアクセサリ・仮のコントローラーの値・物のパラメータの値は物なので、物といっしょに消える)
  resetScene(): void {
    this.clearEffects();
    this.store.clearFolders();
    this.set({ ...MME_DEFAULTS });
  }

  // 保存の前に: 割り当てた .fx (全部のタブ)・ポストエフェクト (隠したアクセサリのものも)・それらのオフスクリーンの DefaultEffect で描く .fx と、その画像を、
  // 描いていなくても読んだファイル (EffectStore のフォルダの used) にする (保存するファイル)
  whenFilesRead(): Promise<void> {
    return this.renderer.whenFilesRead();
  }

  // 書き出しの前に:使う .fx のテクスチャと、MMD モデルの .pmx を読み終える (失敗しても) まで待つ
  whenReady(): Promise<void> {
    return this.renderer.whenReady();
  }

  // 描画先を作り直すとき (描画先の資源は使えなくなる)
  reset(): void {
    this.renderer.dispose();
    this.publish();
  }

  // MME 互換で描く。例外を出したら false (そのフレームは標準のエンジンと効果で描く。同じ例外のお知らせは 1 回。
  // 毎フレーム同じ例外が出るあいだは、コンソールにも 1 回だけ書く)
  private draw(): boolean {
    try {
      const drawn = this.renderer.render();
      this.logged = null;
      this.publish(); // (描いたときの警告)
      return drawn;
    } catch (err) {
      const error = errorText(err);
      if (error !== this.logged) {
        this.logged = error;
        console.error(err);
      }
      if (!this.reported.has(error)) {
        this.reported.add(error);
        this.deps.ui.toast(t('MME 互換で描けなかったので、標準のエンジンで描きました: {error}', { error }), 8000);
      }
      return false;
    }
  }
}
