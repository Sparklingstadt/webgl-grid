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
