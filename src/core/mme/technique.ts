// MME の technique の選び方: 注釈 (MMDPass・Subset・UseTexture ...) が条件に合う最初のもの
import type { EffectDesc, Technique } from '../fx/desc.ts';
import { annotation } from './annotations.ts';
import type { MmdPass } from './semantics.ts';

export interface TechniqueQuery { pass: MmdPass; subset: number; useTexture: boolean; useSphereMap: boolean; useToon: boolean; selfShadow: boolean }

// "0-3,5" や "6-" (6 以上) の形。壊れた項は無視する
export function subsetMatcher(spec: string): (i: number) => boolean {
  const ranges: [number, number][] = [];
  for (const part of spec.split(',')) {
    const m = /^\s*(\d+)\s*(-\s*(\d*))?\s*$/.exec(part);
    if (!m) continue;
    const lo = Number(m[1]);
    ranges.push([lo, m[2] === undefined ? lo : m[3] === '' ? Infinity : Number(m[3])]);
  }
  return i => ranges.some(([lo, hi]) => i >= lo && i <= hi);
}

// bool の注釈 (なければ undefined)
function flag(t: Technique, name: string): boolean | undefined {
  const v = annotation(t.annotations, name)?.value;
  return Array.isArray(v) && v.length > 0 ? v[0] !== 0 : undefined;
}

function matches(t: Technique, pass: MmdPass, q: TechniqueQuery): boolean {
  const p = annotation(t.annotations, 'MMDPass')?.value;
  if ((typeof p === 'string' ? p.trim().toLowerCase() : 'object') !== pass) return false;
  const subset = annotation(t.annotations, 'Subset')?.value;
  if (typeof subset === 'string' && !subsetMatcher(subset)(q.subset)) return false;
  const want: [string, boolean][] = [['UseTexture', q.useTexture], ['UseSphereMap', q.useSphereMap], ['UseToon', q.useToon], ['UseSelfShadow', q.selfShadow]];
  return want.every(([name, v]) => (flag(t, name) ?? v) === v);
}

// null は「この pass の technique がない」。中身が空の technique はそのまま返す (呼ぶ側が「描かない」と読む)
export function pickTechnique(effect: EffectDesc, q: TechniqueQuery): Technique | null {
  const find = (pass: MmdPass) => effect.techniques.find(t => matches(t, pass, q)) ?? null;
  const t = find(q.pass);
  return t ?? (q.pass === 'object_ss' ? find('object') : null);
}
