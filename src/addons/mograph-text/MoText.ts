import * as THREE from 'three';
import { num } from '../../core/normalize';
import { shapeDef } from '../../core/shapes';
import type { AddonApi, ObjectData } from '../../engine/addons/Addons';
import { isShape, type Obj } from '../../engine/types';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import { normalizeEffectors, type Effector, type Placement } from '../cinema4d/cloner';
import { applyEffectors, hasLive } from '../cinema4d/effectors';
import { clearGlyphs, cssFont, glyphGeometry, glyphShape } from './glyphs';
import { layoutText, unitsOf, type TextUnit } from './layout';

// --- MoText (Cinema 4D の MoText): 厚みのある文字を立てて並べ、文字・単語・行ごとにエフェクタで動かす ---
// 形の物を「テキストにする」と、元の形を隠して文字を出す。積み重ねの足場と高さも、文字の大きさにする
export interface TextSettings {
  text: string;
  font: string;        // sans-serif・serif・monospace か、フォントの名前
  weight: 'normal' | 'bold';
  size: number;        // 文字の高さ (おおよそ)
  depth: number;       // 厚み
  bevel: number;       // 面取り (厚みの割合 0〜0.5)
  spacing: number;     // 字間 (文字の大きさの割合)
  lineSpacing: number; // 行間 (文字の大きさの倍数)
  align: 'left' | 'center' | 'right';
  unit: TextUnit;      // エフェクタをかける単位
  effectors: Effector[];
}
export const TEXT_DEFAULT: TextSettings = {
  text: 'MoText', font: 'sans-serif', weight: 'bold', size: 1, depth: 0.25, bevel: 0, spacing: 0, lineSpacing: 1.2, align: 'center', unit: 'letters', effectors: [],
};
export const MAX_CHARS = 200;
export function normalizeText(o: Partial<TextSettings> | null | undefined): TextSettings {
  const d = TEXT_DEFAULT, s = o ?? {};
  return {
    text: typeof s.text === 'string' ? [...s.text].slice(0, MAX_CHARS * 2).join('') : d.text,
    font: typeof s.font === 'string' && s.font.trim() && !/[;{}<>]/.test(s.font) ? s.font.trim().slice(0, 100) : d.font,
    weight: s.weight === 'normal' ? 'normal' : 'bold',
    size: num(s.size, d.size, 0.05, 20), depth: num(s.depth, d.depth, 0.001, 20), bevel: num(s.bevel, d.bevel, 0, 0.5),
    spacing: num(s.spacing, d.spacing, -0.5, 2), lineSpacing: num(s.lineSpacing, d.lineSpacing, 0.3, 5),
    align: s.align === 'left' || s.align === 'right' ? s.align : 'center',
    unit: (['letters', 'words', 'lines', 'all'] as const).includes(s.unit!) ? s.unit! : 'letters',
    effectors: normalizeEffectors(s.effectors),
  };
}

interface Unit { group: THREE.Group; center: THREE.Vector3 }
interface State { root: THREE.Group; units: Unit[]; sig: string }
const NAME = '__motext';

export class MoText {
  private states = new WeakMap<Obj, State>();
  private readonly data: ObjectData<TextSettings>;
  private readonly settingsOf: (o: Obj) => TextSettings | null;
  private readonly offs: (() => void)[];
  private on = true;
  readonly problems = new WeakMap<Obj, string>();

  constructor(private api: AddonApi, private c4d: Cinema4d) {
    this.settingsOf = o => (this.on ? (o.addonData?.[`${api.id}.text`] as TextSettings | undefined) ?? null : null);
    this.data = api.addObjectData<TextSettings>({ key: 'text', label: 'テキスト', normalize: raw => normalizeText(raw as Partial<TextSettings>), apply: o => this.rebuild(o) });
    api.onBeforeRender(() => this.sync());
    this.offs = [
      c4d.events.on('registry', () => { for (const o of api.engine.world.objects) if (this.states.has(o)) this.place(o); }),
      c4d.addEffectorSource(o => this.settingsOf(o)?.effectors ?? null),
    ];
  }
  off() { this.on = false; for (const f of this.offs) f(); clearGlyphs(); }

  get(o: Obj | null | undefined) { return o ? this.data.get(o) : null; }
  set(o: Obj, patch: Partial<TextSettings> | null) { this.data.set(o, patch === null ? null : normalizeText({ ...this.data.get(o), ...patch })); }
  count(o: Obj | null | undefined) { return o ? this.states.get(o)?.units.length ?? 0 : 0; }
  // 文字の形 (メッシュ) の数 (空白は数えない)
  letters(o: Obj) { let n = 0; this.states.get(o)?.root.traverse(c => { if ((c as THREE.Mesh).isMesh) n++; }); return n; }

  rebuild(o: Obj) {
    const old = this.states.get(o);
    if (old) { o.node.remove(old.root); this.states.delete(o); }
    this.problems.delete(o);
    const s = this.settingsOf(o), src = o.mesh;
    const def = shapeDef(o.s);
    if (!s || !src || !isShape(o)) {
      // 元の形と足場に戻す
      if (src && !this.c4d.cloner(o)) src.visible = true;
      if (isShape(o)) { Object.assign(o, { h: def.h, hx: def.hx, hz: def.hz }); this.api.engine.world.settle(); }
      this.api.engine.viewport.requestDraw();
      return;
    }
    if (this.c4d.cloner(o) || this.api.engine.addons.exposed<{ get(o: Obj): unknown }>('mograph-fracture')?.get(o)) {
      this.problems.set(o, 'クローナー・分割にしている物は、テキストにできません');
      return;
    }
    const font = cssFont(s.font, s.weight);
    const layout = layoutText(s.text, { size: s.size, spacing: s.spacing, lineSpacing: s.lineSpacing, align: s.align, advance: ch => glyphShape(ch, font).advance });
    const root = new THREE.Group();
    root.name = NAME;
    const depthEm = s.depth / s.size, bevelEm = Math.min(s.bevel * depthEm, 0.08);
    const units: Unit[] = unitsOf(layout, s.unit).slice(0, MAX_CHARS).map(idx => {
      const cs = idx.map(i => layout.chars[i]);
      // 単位の真ん中 (文字の送り幅と、おおよその高さで)
      const minX = Math.min(...cs.map(c => c.x)), maxX = Math.max(...cs.map(c => c.x + glyphShape(c.ch, font).advance * s.size));
      const center = new THREE.Vector3((minX + maxX) / 2, (Math.min(...cs.map(c => c.y)) + Math.max(...cs.map(c => c.y))) / 2 + 0.35 * s.size, 0);
      const group = new THREE.Group();
      for (const c of cs) {
        const g = glyphGeometry(c.ch, font, depthEm, bevelEm);
        if (!g) continue;
        const m = new THREE.Mesh(g, src.material);
        m.scale.setScalar(s.size);
        m.position.set(c.x - center.x, c.y - center.y, 0);
        m.castShadow = m.receiveShadow = true;
        group.add(m);
      }
      root.add(group);
      return { group, center };
    });
    o.node.add(root);
    src.visible = false;
    // 積み重ねの足場と高さを、文字の大きさに
    Object.assign(o, { h: Math.max(layout.top, 0.05), hx: Math.max(layout.width / 2, 0.05), hz: Math.max(s.depth / 2, 0.05) });
    this.states.set(o, { root, units, sig: '' });
    this.place(o);
    this.api.engine.world.settle();
  }

  // 単位ごとの置き場所 (エフェクタをかけた後)
  private place(o: Obj) {
    const st = this.states.get(o), s = this.settingsOf(o);
    if (!st || !s) return;
    const ps: Placement[] = st.units.map(u => ({ x: u.center.x, y: u.center.y, z: u.center.z, ry: 0, scale: 1, delay: 0 }));
    applyEffectors(ps, s.effectors, this.c4d.env(o));
    const sig = JSON.stringify(ps);
    if (sig === st.sig) return;
    st.sig = sig;
    st.units.forEach((u, i) => {
      const p = ps[i];
      u.group.position.set(p.x, p.y, p.z);
      u.group.rotation.y = p.ry;
      u.group.scale.setScalar(Math.max(p.scale, 1e-4));
    });
    this.api.engine.viewport.requestDraw();
  }

  // 描く前: 材質を合わせ、時刻・位置で変わるエフェクタがあれば並べ直す
  private sync() {
    for (const o of this.api.engine.world.objects) {
      const st = this.states.get(o), s = this.settingsOf(o);
      if (!st || !s || !o.mesh) continue;
      if (this.c4d.cloner(o)) { this.rebuild(o); continue; }
      o.mesh.visible = false;
      st.root.traverse(c => { const m = c as THREE.Mesh; if (m.isMesh && m.material !== o.mesh!.material) m.material = o.mesh!.material; });
      if (hasLive(s.effectors, this.c4d.env(o))) this.place(o);
    }
  }
}
