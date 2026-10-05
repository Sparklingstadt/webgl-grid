// CONTROLOBJECT の項目 (Ray-MMD などが、場面の物 (コントローラー) の値を読むための宣言)。
// 値の用意は呼ぶ側 (SemanticContext.control)。ここは宣言を集め、場面にない名前の「仮のコントローラー」の欄を数える。
import type { EffectDesc, Param } from '../fx/desc.ts';
import { annotation } from './annotations.ts';

export type ControlType = 'float' | 'float3' | 'float4' | 'float4x4' | 'bool';
export interface ControlRef { param: string; name: string; item: string | null; type: ControlType }

const CONTROL_TYPES: readonly string[] = ['float', 'float3', 'float4', 'float4x4', 'bool'];

function stringAnnotation(p: Param, name: string): string | null {
  const a = annotation(p.annotations, name);
  return a && typeof a.value === 'string' ? a.value : null;
}

// CONTROLOBJECT の param を項目にする。CONTROLOBJECT でなくても、型が合わなくても、name がなくても null
export function controlRef(p: Param): ControlRef | null {
  if (p.semantic?.toUpperCase() !== 'CONTROLOBJECT') return null;
  if (!CONTROL_TYPES.includes(p.type)) return null;
  const name = stringAnnotation(p, 'name');
  if (name === null) return null;
  return { param: p.name, name, item: stringAnnotation(p, 'item'), type: p.type as ControlType };
}

// 型が合わない・name がない CONTROLOBJECT は捨てる (呼ぶ側が警告する)
export function controlRefs(desc: EffectDesc): ControlRef[] {
  const out: ControlRef[] = [];
  for (const p of desc.params) {
    const r = controlRef(p);
    if (r) out.push(r);
  }
  return out;
}

// 「自分自身」と「この描画の持ち主」。場面の物の名前ではない
export function isSpecialName(name: string): boolean {
  const n = name.toLowerCase();
  return n === '(self)' || n === '(offscreenowner)';
}

// 場面にない名前 (仮のコントローラー) ごとに、スライダーにできる項目 (float で item のあるもの) を、重複なく名前順で。項目のない名前は載せない
export function virtualControls(refs: ControlRef[], present: (name: string) => boolean): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const r of refs) {
    if (isSpecialName(r.name) || present(r.name)) continue;
    if (r.type !== 'float' || r.item === null) continue;
    let s = sets.get(r.name);
    if (!s) sets.set(r.name, s = new Set());
    s.add(r.item);
  }
  const out = new Map<string, string[]>();
  for (const [name, s] of sets) out.set(name, [...s].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  return out;
}
