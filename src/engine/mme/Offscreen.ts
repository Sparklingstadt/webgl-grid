import type * as THREE from 'three';
import type { Annotation } from '../../core/fx/index.ts';
import { dirname } from '../../core/fx/source.ts';
import { t } from '../../core/i18n';
import { annotation } from '../../core/mme/annotations.ts';
import { parseDefaultEffect, type DefaultRule } from '../../core/mme/defaultEffect.ts';
import { textureRole } from '../../core/mme/semantics.ts';
import { targetSpec, type TargetFormat, type TargetSpec } from '../../core/mme/targets.ts';
import { STAGE, type DefaultsOf, type Owner } from './Assignments';
import type { LoadedEffect } from './EffectStore';
import type { ColorTarget, DrawTarget, Framebuffers, Surface } from './Framebuffers';
import type { FrameState } from './PostChain';
import type { PassTable, Slot, SlotFor, TableUse } from './ScenePass';

// --- オフスクリーン (OFFSCREENRENDERTARGET): 宣言ごとのタブの割り当て表 (割り当て → DefaultEffect) で、場面をそのターゲットに描く ---
// 描く順 (設計書「1 フレームの流れ」の 4): エフェクトの宣言の逆の順に、1 フレームに 1 回。shared のものは名前ごとに 1 つ、
// shared でないものは (エフェクト・名前・持ち主) ごと。入れ子 (物のエフェクトが宣言するもの。持ち主はその物) は、
// それを使う表を描く前に描き終える (ターゲットを描いている途中で、ほかのターゲットに描かない)。深さは 2 まで

export interface OffscreenDecl {
  effect: LoadedEffect; name: string; shared: boolean; width: number; height: number /* ViewportRatio は画面の大きさから */; format: TargetFormat;
  clearColor: [number, number, number, number]; clearDepth: number; antiAlias: boolean; mipLevels: number; rules: DefaultRule[];
  description: string; // Description (割り当てのタブの説明)
  draws: boolean; // このエフェクトが描くか (DefaultEffect のない shared の宣言は、ほかのエフェクトが描くものを読むだけ)
}

export type OffscreenUse = TableUse;
export interface OffscreenScene {
  draw(table: PassTable, frame: FrameState, target: DrawTarget): void; // 表のとおりに、いまの描画先に場面を描く
  uses(table: PassTable, frame: FrameState): OffscreenUse[]; // その表で描く物とエフェクトの組
}
export type OffscreenTargets = Pick<Framebuffers, 'current' | 'defaultSurface' | 'bindSurface' | 'clear' | 'offscreenTarget' | 'offscreenSurface' | 'dropOffscreen'>;
export interface OffscreenDeps {
  fb(): OffscreenTargets;
  scene: OffscreenScene;
  slotFor(tab: string, defaults: DefaultsOf, owner: Owner): SlotFor; // そのタブの割り当て (Assignments.slotFor)
  prepare(effect: LoadedEffect, screen: [number, number]): void; // オフスクリーンに描くエフェクトのレンダーターゲットを用意する
  stopped(effect: LoadedEffect): boolean; // GPU で使えないので止めたか
  warn(message: string, effect: LoadedEffect | null): void; // effect: そのエフェクトの警告 (null は全体の警告)
}

const MAX_DEPTH = 2;
const HIDE: Slot = { kind: 'hide' };

function numbers(list: Annotation[], name: string): number[] | null {
  const v = annotation(list, name)?.value;
  return Array.isArray(v) && v.length > 0 ? v : null;
}
function text(list: Annotation[], name: string): string | null {
  const v = annotation(list, name)?.value;
  return typeof v === 'string' ? v : null;
}

// エフェクトの OFFSCREENRENDERTARGET の宣言 (書いた順)。ClearColor の既定は (0, 0, 0, 0)、ClearDepth は 1、MipLevels は 1
export function offscreenDecls(effect: LoadedEffect, screen: [number, number]): { decls: OffscreenDecl[]; warnings: string[] } {
  const decls: OffscreenDecl[] = [];
  const warnings: string[] = [];
  if (!effect.result.ok) return { decls, warnings };
  for (const tex of effect.result.effect.textures) {
    if (textureRole(tex) !== 'offscreen') continue;
    const an = tex.annotations;
    const spec = targetSpec(tex, screen, false);
    warnings.push(...spec.warnings);
    const defaultEffect = text(an, 'DefaultEffect');
    const parsed = defaultEffect === null ? { rules: [], warnings: [] } : parseDefaultEffect(defaultEffect);
    warnings.push(...parsed.warnings.map(w => `${tex.name}: ${w}`));
    const antiAlias = (numbers(an, 'AntiAlias')?.[0] ?? 0) !== 0;
    if (antiAlias) warnings.push(t('オフスクリーン {name} の AntiAlias には対応していないので、アンチエイリアスなしで描きます', { name: tex.name }));
    const c = numbers(an, 'ClearColor');
    decls.push({
      effect, name: tex.name, shared: tex.shared, width: spec.width, height: spec.height, format: spec.format,
      clearColor: [c?.[0] ?? 0, c?.[1] ?? 0, c?.[2] ?? 0, c?.[3] ?? 0], clearDepth: numbers(an, 'ClearDepth')?.[0] ?? 1,
      antiAlias, mipLevels: numbers(an, 'MipLevels')?.[0] ?? 1, rules: parsed.rules,
      description: text(an, 'Description') ?? '', draws: !tex.shared || defaultEffect !== null,
    });
  }
  return { decls, warnings };
}

// 描いたオフスクリーン 1 つ。drawnAt: 描いたフレーム、usedAt: 最後に使ったフレーム、effects: その表で描いたエフェクト
interface Entry {
  decl: OffscreenDecl; target: ColorTarget | null; surface: Surface | null; drawnAt: number; usedAt: number; effects: Set<LoadedEffect>;
}

export class Offscreen {
  private frameNo = 0;
  private entries = new Map<string, Entry>(); // 'shared|名前' か 'エフェクトの id|名前|持ち主の id'
  private decls = new Map<LoadedEffect, { screen: string; decls: OffscreenDecl[] }>();
  private declared = new Map<string, string>(); // このフレームに使ったエフェクトが宣言するオフスクリーンの名前 → Description
  // このフレームにオフスクリーンの名前ごとの、最初に描く宣言 (DefaultEffect のあるもの) と、それを宣言したエフェクトで描く物 (ポストエフェクトは null)
  private drawers = new Map<string, { decl: OffscreenDecl; owners: Set<Owner> }>();
  private warned = new Set<string>();

  constructor(private d: OffscreenDeps) {}

  // フレームの初め: 前のフレームで使わなかったオフスクリーン (持ち主を消した・エフェクトを外した) を捨てる。捨てたら true
  begin(frameNo: number): boolean {
    let dropped = false;
    for (const [key, e] of this.entries) {
      if (e.usedAt >= this.frameNo) continue;
      this.d.fb().dropOffscreen(key);
      this.entries.delete(key);
      dropped = true;
    }
    this.frameNo = frameNo;
    this.declared.clear();
    this.drawers.clear();
    return dropped;
  }

  // そのエフェクトが宣言するオフスクリーンを、このフレームでまだ描いていなければ、宣言の逆の順に描く。
  // owner はそのエフェクトで描く物 (ポストエフェクトは null)
  ensure(effect: LoadedEffect, owner: Owner, frame: FrameState): void {
    this.ensureAt(effect, owner, frame, 1);
  }

  // エフェクトが宣言したオフスクリーンのテクスチャ (shared なら名前で、ほかのエフェクトが描いたもの)。描いていなければ null
  texture(effect: LoadedEffect, name: string, owner: Owner): THREE.Texture | null {
    const tex = effect.result.ok ? effect.result.effect.textures.find(x => x.name === name) : undefined;
    if (!tex) return null;
    return this.entries.get(tex.shared ? `shared|${name}` : `${effect.id}|${name}|${ownerKey(owner)}`)?.target?.tex ?? null;
  }

  // このフレームに使ったエフェクトが宣言するオフスクリーンの名前と Description (名前ごとに 1 つ。割り当てのタブ)
  tabs(): { name: string; description: string }[] {
    return [...this.declared].map(([name, description]) => ({ name, description }));
  }

  // このフレームにそのタブ (オフスクリーンの名前) を描いた割り当て表の DefaultEffect (最初に描く宣言のもの) と、持ち主 (self に合う物)。
  // 描く宣言がなければ null (DefaultEffect のない shared の宣言だけ。そのタブの割り当ては効かない)
  tabDefaults(name: string): { defaults: DefaultsOf; owners: Set<Owner> } | null {
    const d = this.drawers.get(name);
    return d ? { defaults: defaultsOf(d.decl), owners: d.owners } : null;
  }

  // オフスクリーンを宣言したエフェクトと、オフスクリーンに描いたエフェクト (資源を捨てない)
  effects(): Set<LoadedEffect> {
    const out = new Set<LoadedEffect>();
    for (const e of this.entries.values()) {
      out.add(e.decl.effect);
      for (const x of e.effects) out.add(x);
    }
    return out;
  }

  // 覚えているものを忘れる (ターゲットは Framebuffers.dispose が捨てる)
  dispose(): void {
    this.entries.clear();
    this.decls.clear();
    this.declared.clear();
    this.drawers.clear();
    this.warned.clear();
    this.frameNo = 0;
  }

  private ensureAt(effect: LoadedEffect, owner: Owner, frame: FrameState, depth: number): void {
    const decls = this.declsOf(effect, frame.screen);
    if (decls.length === 0 || this.d.stopped(effect)) return;
    for (const decl of decls) {
      if (!this.declared.get(decl.name)) this.declared.set(decl.name, decl.description);
      if (!decl.draws) continue;
      let drawer = this.drawers.get(decl.name);
      if (!drawer) this.drawers.set(decl.name, (drawer = { decl, owners: new Set() }));
      drawer.owners.add(owner);
    }
    for (let i = decls.length - 1; i >= 0; i--) {
      const decl = decls[i];
      if (!decl.draws || this.d.stopped(effect)) continue;
      const key = decl.shared ? `shared|${decl.name}` : `${effect.id}|${decl.name}|${ownerKey(owner)}`;
      const entry = this.entries.get(key);
      if (entry?.drawnAt === this.frameNo) {
        entry.usedAt = this.frameNo;
        if (entry.decl !== decl && !sameLayout(entry.decl, decl)) {
          this.warnOnce(`layout|${key}|${effect.id}`, t('共有のオフスクリーン {name} の形か大きさが、先に描いたエフェクトの宣言と違うので、先に描いたものを使います', { name: decl.name }), effect);
        }
        continue;
      }
      if (depth > MAX_DEPTH) {
        this.warnOnce(`depth|${key}`, t('オフスクリーン {name} は入れ子の {depth} 段目なので描きません ({max} 段まで)', { name: decl.name, depth, max: MAX_DEPTH }), effect);
        continue;
      }
      this.draw(key, entry, decl, owner, frame, depth);
    }
  }

  // 1 つのオフスクリーンを描く: その表で描く物のエフェクトのレンダーターゲットを用意し、それらのオフスクリーン (入れ子) を先に描いてから、
  // ClearColor・ClearDepth (とステンシル 0) で消して、オフスクリーンを既定の描画先にして場面を描く。終わったら元の描画先に戻す
  private draw(key: string, old: Entry | undefined, decl: OffscreenDecl, owner: Owner, frame: FrameState, depth: number): void {
    const fb = this.d.fb();
    const entry: Entry = old ?? { decl, target: null, surface: null, drawnAt: 0, usedAt: 0, effects: new Set() };
    entry.decl = decl;
    entry.drawnAt = entry.usedAt = this.frameNo;
    entry.effects = new Set();
    this.entries.set(key, entry);
    const spec: TargetSpec = { width: decl.width, height: decl.height, format: decl.format, mipmaps: decl.mipLevels !== 1, warnings: [] };
    const { target, warnings } = fb.offscreenTarget(key, decl.effect, decl.name, spec);
    for (const w of warnings) this.d.warn(w, decl.effect);
    if (!target) return; // (この環境で描けない形式。Framebuffers がエフェクトを止めた)
    if (entry.target !== target || !entry.surface) {
      entry.target = target;
      entry.surface = fb.offscreenSurface(target);
    }
    const table: PassTable = { name: decl.name, owner, slotFor: this.slotFor(decl, owner) };
    const uses = this.d.scene.uses(table, frame);
    for (const u of uses) {
      entry.effects.add(u.effect);
      this.d.prepare(u.effect, frame.screen);
    }
    for (const u of uses) this.ensureAt(u.effect, u.obj, frame, depth + 1);
    const outer = fb.current, outerDefault = fb.defaultSurface;
    const drawTarget = fb.bindSurface(entry.surface);
    try {
      // (フレームバッファを作れなければ、Framebuffers がエフェクトを止めて別の描画先にしている)
      if (fb.current !== entry.surface) return;
      fb.clear(decl.clearColor, decl.clearDepth, 0);
      this.d.scene.draw(table, frame, drawTarget);
    } finally {
      fb.defaultSurface = outerDefault;
      fb.bindSurface(outer); // (ミップマップのあるオフスクリーンは、ここでミップを作る)
    }
  }

  // オフスクリーンのタブの割り当て。このフレームのうちは同じものを返す (描いている途中で止めても、次のフレームまで変えない)。
  // 止めたエフェクトは描かない (default.fx の陰影を G バッファや影のマップに書かない)
  private slotFor(decl: OffscreenDecl, owner: Owner): SlotFor {
    const resolve = this.d.slotFor(decl.name, defaultsOf(decl), owner);
    const memo = new Map<THREE.Mesh, Map<number, Slot>>();
    return (obj, mesh, materialIndex) => {
      let slots = memo.get(mesh);
      if (!slots) memo.set(mesh, (slots = new Map()));
      let slot = slots.get(materialIndex);
      if (!slot) {
        slot = resolve(obj, mesh, materialIndex);
        if (slot.kind === 'effect' && this.d.stopped(slot.effect)) {
          this.warnOnce(`stopped|${decl.name}|${slot.effect.id}`, t('{name} を止めたので、オフスクリーン {tab} では描きません', { name: slot.effect.name, tab: decl.name }), null);
          slot = HIDE;
        }
        slots.set(materialIndex, slot);
      }
      return slot;
    };
  }

  // エフェクトの宣言 (画面の大きさが変わったら作り直す)。宣言の警告はそのエフェクトの警告
  private declsOf(effect: LoadedEffect, screen: [number, number]): OffscreenDecl[] {
    const size = `${screen[0]}x${screen[1]}`;
    const old = this.decls.get(effect);
    if (old && old.screen === size) return old.decls;
    const { decls, warnings } = offscreenDecls(effect, screen);
    for (const w of warnings) this.d.warn(w, effect);
    this.decls.set(effect, { screen: size, decls });
    return decls;
  }

  private warnOnce(key: string, message: string, effect: LoadedEffect | null): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.d.warn(message, effect);
  }
}

// 宣言の DefaultEffect (規則のパスは、宣言しているエフェクトのエントリーの .fx があるフォルダから)
export function defaultsOf(decl: OffscreenDecl): DefaultsOf {
  return { rules: decl.rules, base: dirname(decl.effect.entry), folder: decl.effect.folder };
}

function sameLayout(a: OffscreenDecl, b: OffscreenDecl): boolean {
  return a.width === b.width && a.height === b.height && a.format === b.format && a.mipLevels === b.mipLevels;
}

// 持ち主ごとのオフスクリーンの鍵 (物は番号、ステージは 'stage'、持ち主なしは '')
function ownerKey(owner: Owner): string {
  return owner === STAGE ? STAGE : owner ? String(owner.id) : '';
}
