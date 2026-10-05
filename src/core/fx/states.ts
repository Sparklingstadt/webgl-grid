import { t } from '../i18n.ts';
import type { Expr, ShaderCompile, StateAssign } from './ast.ts';
import type { CheckedEffect } from './check.ts';
import type { Diagnostics } from './diagnostics.ts';
import { typeName } from './types.ts';

// --- 描画ステート (pass と sampler_state の中の name = 値;) を表の書き方と値に直す ---
export type StateValue = number | boolean | string | number[] | { expr: string };
export interface RenderState { name: string; index?: number; value: StateValue }

type StateKind =
  | { kind: 'bool' }
  | { kind: 'enum'; values: string[] }
  | { kind: 'number' }
  | { kind: 'mask' } // ColorWriteEnable (RED | GREEN | BLUE | ALPHA)。添字 0〜3
  | { kind: 'color' } // BorderColor (数か数の並び)
  | { kind: 'texture' };
interface StateInfo { scope: 'pass' | 'sampler'; spec: StateKind }

const words = (s: string): string[] => s.split(' ');
const BLEND = words('ZERO ONE SRCCOLOR INVSRCCOLOR SRCALPHA INVSRCALPHA DESTALPHA INVDESTALPHA DESTCOLOR INVDESTCOLOR SRCALPHASAT BOTHSRCALPHA BOTHINVSRCALPHA BLENDFACTOR INVBLENDFACTOR');
const BLEND_OP = words('ADD SUBTRACT REVSUBTRACT MIN MAX');
const COMPARE = words('NEVER LESS EQUAL LESSEQUAL GREATER NOTEQUAL GREATEREQUAL ALWAYS');
const STENCIL_OP = words('KEEP ZERO REPLACE INCRSAT DECRSAT INVERT INCR DECR');
const FILTER = words('NONE POINT LINEAR ANISOTROPIC');
const ADDRESS = words('WRAP MIRROR CLAMP BORDER MIRRORONCE');

// 表。名前は表の書き方 (大文字小文字を無視して照らす)
const STATE_TABLE: Record<string, StateInfo> = {};
function define(scope: StateInfo['scope'], names: string, spec: StateKind): void {
  for (const name of words(names)) STATE_TABLE[name] = { scope, spec };
}
define('pass', 'ZEnable ZWriteEnable AlphaBlendEnable AlphaTestEnable SeparateAlphaBlendEnable StencilEnable TwoSidedStencilMode MultiSampleAntialias SRGBWriteEnable ScissorTestEnable PointSpriteEnable', { kind: 'bool' });
define('pass', 'SrcBlend DestBlend SrcBlendAlpha DestBlendAlpha', { kind: 'enum', values: BLEND });
define('pass', 'BlendOp BlendOpAlpha', { kind: 'enum', values: BLEND_OP });
define('pass', 'ZFunc AlphaFunc StencilFunc CCW_StencilFunc', { kind: 'enum', values: COMPARE });
define('pass', 'CullMode', { kind: 'enum', values: words('NONE CW CCW') });
define('pass', 'FillMode', { kind: 'enum', values: words('POINT WIREFRAME SOLID') });
define('pass', 'ShadeMode', { kind: 'enum', values: words('FLAT GOURAUD') });
define('pass', 'StencilPass StencilFail StencilZFail CCW_StencilPass CCW_StencilFail CCW_StencilZFail', { kind: 'enum', values: STENCIL_OP });
define('pass', 'AlphaRef StencilRef StencilMask StencilWriteMask DepthBias SlopeScaleDepthBias BlendFactor', { kind: 'number' });
define('pass', 'ColorWriteEnable', { kind: 'mask' });
define('sampler', 'SRGBTexture', { kind: 'bool' });
define('sampler', 'MinFilter MagFilter MipFilter', { kind: 'enum', values: FILTER });
define('sampler', 'AddressU AddressV AddressW', { kind: 'enum', values: ADDRESS });
define('sampler', 'BorderColor', { kind: 'color' });
define('sampler', 'MaxAnisotropy MaxMipLevel MipMapLodBias', { kind: 'number' });
define('sampler', 'Texture', { kind: 'texture' });

const BY_LOWER = new Map(Object.keys(STATE_TABLE).map(name => [name.toLowerCase(), name]));
const COLOR_MASK: Record<string, number> = { red: 1, green: 2, blue: 4, alpha: 8 };

// 式を読める形に書き出す (元の文字列は構文木に残らないので)
function printExpr(e: Expr, top = true): string {
  const p = (x: Expr): string => printExpr(x, false);
  const wrap = (s: string): string => (top ? s : `(${s})`);
  switch (e.kind) {
    case 'number': return e.isFloat && Number.isInteger(e.value) ? e.value.toFixed(1) : String(e.value);
    case 'bool': return String(e.value);
    case 'string': return JSON.stringify(e.value);
    case 'ident': return e.name;
    case 'unary': return e.postfix ? `${p(e.operand)}${e.op}` : `${e.op}${p(e.operand)}`;
    case 'binary': return `(${p(e.left)} ${e.op} ${p(e.right)})`;
    case 'assign': return wrap(`${p(e.target)} ${e.op} ${p(e.value)}`);
    case 'ternary': return wrap(`${p(e.cond)} ? ${p(e.then)} : ${p(e.else)}`);
    case 'call': return `${e.callee}(${e.args.map(p).join(', ')})`;
    case 'construct': return `${e.typeRef.kind === 'builtin' ? typeName(e.typeRef.type) : e.typeRef.name}(${e.args.map(p).join(', ')})`;
    case 'cast': return `(${e.typeRef.kind === 'builtin' ? typeName(e.typeRef.type) : e.typeRef.name})${p(e.value)}`;
    case 'member': return `${p(e.object)}.${e.name}`;
    case 'index': return `${p(e.object)}[${printExpr(e.index)}]`;
    case 'initList': return `{ ${e.items.map(p).join(', ')} }`;
    case 'sequence': return e.items.map(p).join(', ');
    case 'samplerState': return 'sampler_state { ... }';
    case 'convert': return printExpr(e.value, top);
  }
}

// RED・GREEN・BLUE・ALPHA だけを数に置き換えた式 (もとの木は変えない)
function substituteColorMask(e: Expr): Expr {
  switch (e.kind) {
    case 'ident': {
      const v = COLOR_MASK[e.name.toLowerCase()];
      return v === undefined ? e : { kind: 'number', value: v, isFloat: false, loc: e.loc };
    }
    case 'binary': return { ...e, left: substituteColorMask(e.left), right: substituteColorMask(e.right) };
    case 'unary': return { ...e, operand: substituteColorMask(e.operand) };
    case 'ternary': return { ...e, cond: substituteColorMask(e.cond), then: substituteColorMask(e.then), else: substituteColorMask(e.else) };
    default: return e;
  }
}

type Normalized = { ok: true; value: StateValue } | { ok: false; why: 'invalid' | 'expr' };
const INVALID: Normalized = { ok: false, why: 'invalid' };
const NON_CONST: Normalized = { ok: false, why: 'expr' };
const done = (value: StateValue): Normalized => ({ ok: true, value });

function normalizeValue(spec: StateKind, e: Expr, checked: CheckedEffect): Normalized {
  // 定数のスカラー。計算できなければ null
  const scalar = (x: Expr): number | null => {
    const v = checked.constEval(x);
    return v?.kind === 'num' && v.values.length === 1 && v.type.k === 'scalar' ? v.values[0] : null;
  };
  switch (spec.kind) {
    case 'bool': {
      if (e.kind === 'ident' && /^(true|false)$/i.test(e.name)) return done(e.name.toLowerCase() === 'true');
      const n = scalar(e);
      return n === null ? NON_CONST : done(n !== 0);
    }
    case 'enum': {
      if (e.kind === 'ident') {
        const up = e.name.toUpperCase();
        if (spec.values.includes(up)) return done(up);
        // 定数や uniform の名前なら式のまま。どこにもない名前は誤った値
        return checked.globals.has(e.name) ? NON_CONST : INVALID;
      }
      return checked.constEval(e) === null ? NON_CONST : INVALID;
    }
    case 'number': {
      const n = scalar(e);
      return n === null ? NON_CONST : done(n);
    }
    case 'mask': {
      const v = checked.constEval(substituteColorMask(e));
      if (v?.kind !== 'num' || v.type.k !== 'scalar') return NON_CONST;
      return v.type.s === 'float' ? INVALID : done(v.values[0]);
    }
    case 'color': {
      const v = checked.constEval(e);
      if (v?.kind !== 'num') return NON_CONST;
      return done(v.type.k === 'scalar' ? v.values[0] : v.values);
    }
    case 'texture': return e.kind === 'ident' ? done(e.name) : INVALID;
  }
}

export function normalizeStates(assigns: StateAssign[], kind: 'pass' | 'sampler', checked: CheckedEffect, diags: Diagnostics): RenderState[] {
  const out: RenderState[] = [];
  for (const a of assigns) {
    const lower = a.name.toLowerCase();
    if (kind === 'pass' && (lower === 'vertexshader' || lower === 'pixelshader')) continue;
    const full = a.index === null ? a.name : `${a.name}${a.index}`;
    const name = BY_LOWER.get(lower);
    if (name === undefined) {
      diags.warn('FX-WARN-STATE', a.loc, t('知らないステートなので無視します: {name}', { name: full }));
      continue;
    }
    const info = STATE_TABLE[name];
    if (info.scope !== kind) {
      diags.warn('FX-WARN-STATE', a.loc, t('このステートは {where} には書けないので無視します: {name}', { where: kind, name }));
      continue;
    }
    const indexed = info.spec.kind === 'mask';
    if (a.index !== null && (!indexed || a.index > 3)) {
      diags.warn('FX-WARN-STATE', a.loc, t('ステートの添字が正しくないので無視します: {name}', { name: full }));
      continue;
    }
    const value: Expr | ShaderCompile = a.value;
    if (value.kind === 'compile') {
      diags.warn('FX-WARN-STATE', a.loc, t('ステートの値が正しくないので無視します: {name}', { name }));
      continue;
    }
    const r = normalizeValue(info.spec, value, checked);
    if (r.ok) out.push(indexed ? { name, index: a.index ?? 0, value: r.value } : { name, value: r.value });
    else if (r.why === 'invalid') diags.warn('FX-WARN-STATE', a.loc, t('ステートの値が正しくないので無視します: {name}', { name }));
    else {
      diags.warn('FX-WARN-STATE-EXPR', a.loc, t('ステート {name} の値が定数に計算できないので、式のまま残します', { name }));
      const exprValue = { expr: printExpr(value) };
      out.push(indexed ? { name, index: a.index ?? 0, value: exprValue } : { name, value: exprValue });
    }
  }
  return out;
}
