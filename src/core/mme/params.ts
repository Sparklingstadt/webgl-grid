// エフェクトの「いじれるパラメータ」(初期値を持つ uniform の数値でセマンティクスのないもの) の一覧と、アニメーションのチャンネルの名前
import type { EffectDesc, Param } from '../fx/desc.ts';
import { annotation } from './annotations.ts';

export type ParamUiType = 'float' | 'float2' | 'float3' | 'float4' | 'int' | 'bool';

export interface ParamUi {
  name: string;
  label: string; // UIName、なければ name
  type: ParamUiType;
  init: number[];
  min: number; // 成分に共通の範囲
  max: number;
  color: boolean; // UIWidget = "Color" の float3・float4
}

const PARAM_TYPES: readonly string[] = ['float', 'float2', 'float3', 'float4', 'int', 'bool'];
const SUFFIXES = ['x', 'y', 'z', 'w'];

function numberAnnotation(p: Param, name: string): number | null {
  const a = annotation(p.annotations, name);
  return a && typeof a.value !== 'string' && a.value.length > 0 ? a.value[0] : null;
}

function stringAnnotation(p: Param, name: string): string | null {
  const a = annotation(p.annotations, name);
  return a && typeof a.value === 'string' ? a.value : null;
}

// UIMin・UIMax がなければ、初期値 v から [min(0, 2v), max(1, 2v)] (v の成分の最小・最大)
function paramUi(p: Param, init: number[]): ParamUi {
  const type = p.type as ParamUiType;
  const value = type === 'int' ? init.map(Math.round) : type === 'bool' ? init.map(v => (v !== 0 ? 1 : 0)) : init;
  let min: number, max: number;
  if (type === 'bool') {
    min = 0; max = 1;
  } else {
    const doubled = value.map(v => v * 2);
    min = numberAnnotation(p, 'UIMin') ?? Math.min(0, ...doubled);
    max = numberAnnotation(p, 'UIMax') ?? Math.max(1, ...doubled);
    if (type === 'int') { min = Math.round(min); max = Math.round(max); }
  }
  const color = (type === 'float3' || type === 'float4') && stringAnnotation(p, 'UIWidget')?.toLowerCase() === 'color';
  return { name: p.name, label: stringAnnotation(p, 'UIName') ?? p.name, type, init: value, min, max, color };
}

export function effectParams(desc: EffectDesc): ParamUi[] {
  const out: ParamUi[] = [];
  for (const p of desc.params) {
    if (p.storage !== 'uniform' || p.semantic !== null) continue;
    if (!PARAM_TYPES.includes(p.type) || !Array.isArray(p.init)) continue;
    if ((numberAnnotation(p, 'UIHidden') ?? 0) !== 0) continue;
    out.push(paramUi(p, p.init));
  }
  return out;
}

// アニメーションのチャンネルの名前。float・int・bool は 1 つ、ベクトルは成分ごと (:x :y :z :w)
export function paramChannels(folderId: string, path: string, p: ParamUi): string[] {
  const base = `${folderId}/${path}:${p.name}`;
  if (p.type === 'float' || p.type === 'int' || p.type === 'bool') return [base];
  return p.init.map((_, i) => `${base}:${SUFFIXES[i]}`);
}

// 値を収める範囲 [下, 上]。片方だけ注釈に書いて、もう片方を初期値から決めると入れ替わることがある (UIMax だけ負の値など) ので、そのときは入れ替える
export function paramRange(p: ParamUi): [number, number] {
  return p.min <= p.max ? [p.min, p.max] : [p.max, p.min];
}

// 値を範囲に収める (成分ごと。長さは初期値と同じで、足りない成分・数でない成分は初期値)。int は丸め、bool は 0 か 1 (0.5 から 1)
export function fitParam(p: ParamUi, values: readonly number[]): number[] {
  const [lo, hi] = paramRange(p);
  return p.init.map((init, i) => {
    const raw = values[i];
    let v = typeof raw === 'number' && Number.isFinite(raw) ? raw : init;
    if (p.type === 'int') v = Math.round(v);
    else if (p.type === 'bool') v = v >= 0.5 ? 1 : 0;
    return Math.min(Math.max(v, lo), hi);
  });
}

// 物の MME の値 (チャンネルの名前 → 値) から、パラメータの値 (パラメータの名前 → 成分)。どのチャンネルにも値のないパラメータは入れない。
// ベクトルの一部の成分だけに値があれば、ほかの成分は初期値。範囲に収める
export function paramValues(params: readonly { param: ParamUi; channels: readonly string[] }[], values: Readonly<Record<string, number>>): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const { param, channels } of params) {
    if (!channels.some(ch => values[ch] !== undefined)) continue;
    out.set(param.name, fitParam(param, channels.map((ch, i) => values[ch] ?? param.init[i])));
  }
  return out;
}
