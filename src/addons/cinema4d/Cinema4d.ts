import { MAX_BOXES } from '../../core/constants';
import type { AddonApi, ObjectData } from '../../engine/addons/Addons';
import { Registry } from '../../engine/addons/registry';
import { isModel, type Obj } from '../../engine/types';
import { MAX_CLONES, clonerLayout, normalizeCloner, placeAround, type ClonerSettings, type Effector } from './cloner';
import { Cloners } from './Cloners';
import { normalizeDeformers, type Deformer } from './deform';
import { Deformers } from './Deformers';
import { Emitter } from '../../core/events';
import type { Polyline } from './splines';
import { worldOf, type ClonerModeDef, type EffectorDef, type FieldDef, type LayoutEnv } from './effectors';

// --- Cinema 4D アドオンの中身: クローナー・デフォーマと、MoGraph の登録口 (エフェクタ・フィールド・並べ方) ---
// 設定は物ごとの値 (プロジェクトに入り、元に戻せる)。前の版のプロジェクトの cloner・deformers もそのまま読む。
// engine.addons.exposed('cinema4d') で、ほか (テスト・ほかのアドオン) からも使える
export class Cinema4d {
  readonly cloners: Cloners;
  readonly deformers: Deformers;
  readonly effectors = new Registry<EffectorDef>(); // エフェクタの種類 (MoGraph エフェクタのアドオンが登録する)
  readonly fields = new Registry<FieldDef>();       // フィールドの種類 (MoGraph フィールドのアドオン)
  readonly modes = new Registry<ClonerModeDef>();   // クローナーの並べ方 (MoGraph 配置のアドオン)
  readonly events = new Emitter<{ registry: [] }>(); // 種類が増減した (ほかの MoGraph の物も作り直す)
  private readonly clonerData: ObjectData<ClonerSettings>;
  private readonly deformerData: ObjectData<Deformer[]>;
  private on = true; // 切ったら false (クローンと変形を外すとき、値はあっても「なし」として作り直す)

  constructor(private api: AddonApi) {
    const e = api.engine;
    // (値を読むのは、登録の途中 (有効にしたときに当て直す) でも使えるよう、物の値から直接)
    const value = <T>(key: string) => (o: Obj) => (this.on ? (o.addonData?.[`${api.id}.${key}`] as T | undefined) ?? null : null);
    this.cloners = new Cloners(e.world, e.viewport, () => e.clock.frame, value<ClonerSettings>('cloner'), o => this.env(o));
    // 種類が増減したら、クローナーを並べ直す
    for (const r of [this.effectors, this.fields, this.modes]) r.events.on('changed', () => {
      for (const o of e.world.objects) if (this.cloner(o)) this.cloners.rebuild(o);
      this.events.emit('registry');
      api.refresh();
    });
    this.deformers = new Deformers(this.cloners, e.viewport, value<Deformer[]>('deformers'));
    // 当てる順: クローナー → デフォーマ (デフォーマは、変形した形でクローンを作り直す)
    this.clonerData = api.addObjectData<ClonerSettings>({
      key: 'cloner', aliases: ['cloner'], label: 'クローナー',
      normalize: raw => normalizeCloner(raw as Partial<ClonerSettings>), apply: o => this.cloners.rebuild(o),
    });
    this.deformerData = api.addObjectData<Deformer[]>({
      key: 'deformers', aliases: ['deformers'], label: 'デフォーマ',
      normalize: raw => { const l = normalizeDeformers(raw); return l.length ? l : null; }, apply: o => this.deformers.apply(o),
    });
    api.onBeforeRender(() => this.cloners.sync());
  }
  // 種類を登録する (外す関数を返す)
  addEffector(def: EffectorDef) { return this.effectors.add(def); }
  addField(def: FieldDef) { return this.fields.add(def); }
  addClonerMode(def: ClonerModeDef) { return this.modes.add(def); }
  // 物が持っているエフェクタの並び (クローナーのものと、ほかの MoGraph の物 (分割など) が addEffectorSource で足すもの)
  private sources = new Set<(o: Obj) => Effector[] | null>();
  addEffectorSource(fn: (o: Obj) => Effector[] | null) { this.sources.add(fn); return () => { this.sources.delete(fn); }; }
  effectorsOf(o: Obj): Effector[] {
    return [...(this.cloner(o)?.effectors ?? []), ...[...this.sources].flatMap(fn => fn(o) ?? [])];
  }
  // 物が出すスプライン (場面での折れ線)。MoSpline・トレーサーが addSplineSource で足し、スプラインに並べるクローナーなどが使う
  private splineSources = new Set<(o: Obj) => Polyline[] | null>();
  addSplineSource(fn: (o: Obj) => Polyline[] | null) { this.splineSources.add(fn); return () => { this.splineSources.delete(fn); }; }
  splinesOf(o: Obj | null | undefined): Polyline[] {
    if (!o) return [];
    for (const fn of this.splineSources) { const l = fn(o); if (l?.length) return l; }
    return [];
  }
  // 物 o の MoGraph を並べるときに使うもの (登録された種類・いまの時刻・物の位置)
  env(o: Obj): LayoutEnv {
    const e = this.api.engine;
    return {
      effector: k => this.effectors.get(k), field: k => this.fields.get(k), mode: k => this.modes.get(k),
      time: e.clock.t, origin: { x: o.x, y: o.y, z: o.z, r: o.r },
    };
  }
  // クローナーのクローンの、場面での位置・向き・大きさ (継承のエフェクタなどが使う)
  worldLayout(o: Obj) {
    const c = this.cloner(o);
    if (!c) return [];
    const env = this.env(o);
    return clonerLayout(c, isModel(o) ? MAX_CLONES.model : MAX_CLONES.shape, env).map(p => ({ ...worldOf(p, env.origin), ry: o.r + p.ry, scale: p.scale }));
  }

  // 切るとき (クローンと変形を外す前に呼ぶ)
  off() { this.on = false; }

  cloner(obj: Obj | null | undefined) { return obj ? this.clonerData.get(obj) : null; }
  deformerList(obj: Obj | null | undefined) { return obj ? this.deformerData.get(obj) ?? [] : []; }
  count(obj: Obj | null | undefined) { return obj ? this.cloners.count(obj) : 0; }
  private get current() { return this.api.engine.selection.current; }

  // クローナーにする・設定を変える (patch は今の設定に重ねる。null でやめる)。obj を省くと選んでいる物
  setCloner(patch: Partial<ClonerSettings> | null, obj = this.current) {
    if (!obj) return;
    const cur = this.clonerData.get(obj);
    this.clonerData.set(obj, patch === null ? null : normalizeCloner({ ...cur, ...patch, random: { ...cur?.random, ...patch.random } as ClonerSettings['random'] }));
  }
  // デフォーマを入れ替える (空でやめる)
  setDeformers(list: Deformer[], obj = this.current) {
    if (!obj) return;
    const l = normalizeDeformers(list);
    this.deformerData.set(obj, l.length ? l : null);
  }

  // クローンを、1 つずつの物にする (Cinema 4D の「現在の状態をオブジェクト化」)。形だけ。マテリアルは元の物と共有する
  bake(o = this.current) {
    const e = this.api.engine, c = this.cloner(o);
    if (!o || !c) return false;
    if (isModel(o)) { e.ui.toast('MMD モデルのクローンは、1 つずつの物にはできません'); return false; }
    const layout = clonerLayout(c, MAX_CLONES.shape, this.env(o)).sort((a, b) => a.y - b.y); // 下の段から置く (上の段は積み重なる)
    const room = MAX_BOXES - e.world.objects.length + 1;
    if (layout.length > room) { e.ui.toast(`置ける物は ${MAX_BOXES} 個までなので、クローン ${layout.length} 個を 1 つずつの物にはできません (あと ${room} 個まで)`, 6000); return false; }
    const { x, z, r } = o, slot = o.slots[0], deformers = this.deformerData.get(o);
    // 最初のクローンには元の物を使う (マテリアルを手放さないように)
    this.clonerData.set(o, null);
    layout.forEach((p, i) => {
      const obj = i === 0 ? o : e.world.addShape(o.s, 0, 0, o.c);
      if (i > 0) {
        e.world.setSlot(obj, 0, slot);
        if (deformers) this.deformerData.set(obj, structuredClone(deformers)); // デフォーマも同じに
      }
      Object.assign(obj, placeAround(p, x, z, r));
    });
    e.world.settle();
    e.selection.select(o);
    e.ui.toast(`クローン ${layout.length} 個を、1 つずつの物にしました`);
    e.viewport.requestDraw();
    return true;
  }
}
