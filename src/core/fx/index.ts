import { t } from '../i18n.ts';
import type { AnnotationNode, StateAssign, TechniqueNode } from './ast.ts';
import { check, type CheckedEffect, type GlobalInfo } from './check.ts';
import type {
  Annotation, EffectDesc, Param, Pass, SamplerDecl, Technique, TextureDecl,
} from './desc.ts';
import { Diagnostics, FxError, type Diagnostic } from './diagnostics.ts';
import { glslName } from './emit.ts';
import { emitProgram } from './entry.ts';
import { parse } from './parser.ts';
import { preprocess } from './preprocess.ts';
import { parseScript, type ScriptCommand } from './script.ts';
import { normalizeStates } from './states.ts';
import { typeName, type Dim } from './types.ts';

export type { EffectDesc, Param, TextureDecl, SamplerDecl, Technique, Pass, Program, UniformRef, AttributeRef, Annotation } from './desc.ts';
export type { Diagnostic, DiagCode } from './diagnostics.ts';
export type { ScriptCommand } from './script.ts';
export type { RenderState, StateValue } from './states.ts';

export type EffectResult =
  | { ok: true; effect: EffectDesc; warnings: Diagnostic[] }
  | { ok: false; errors: Diagnostic[]; warnings: Diagnostic[] };

// JSON にして変わらない数にする (Infinity は float の最大値に、NaN と -0 は 0 に)
function jsonNumber(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (!Number.isFinite(x)) return x > 0 ? 3.4028234663852886e38 : -3.4028234663852886e38;
  return x + 0;
}

function annotationsOf(list: AnnotationNode[], checked: CheckedEffect): Annotation[] {
  return list.map(a => {
    const v = checked.constEval(a.value);
    const type = a.type.kind === 'builtin' ? typeName(a.type.type) : a.type.name;
    return { name: a.name, type, value: v?.kind === 'str' ? v.value : v?.kind === 'num' ? v.values.map(jsonNumber) : [] };
  });
}

function initOf(g: GlobalInfo): number[] | string | null {
  const v = g.value;
  return v?.kind === 'str' ? v.value : v?.kind === 'num' ? v.values.map(jsonNumber) : null;
}

// Script 注釈 (名前の大文字小文字は無視) を命令の列にする
function scriptOf(list: AnnotationNode[], checked: CheckedEffect, diags: Diagnostics): ScriptCommand[] {
  const a = list.find(x => x.name.toLowerCase() === 'script');
  const v = a && checked.constEval(a.value);
  return a && v?.kind === 'str' ? parseScript(v.value, a.loc, diags) : [];
}

function samplerOf(name: string, g: GlobalInfo, checked: CheckedEffect, diags: Diagnostics): SamplerDecl {
  const init = g.decl.init;
  const assigns: StateAssign[] = init?.kind === 'samplerState' ? init.states : [];
  const all = normalizeStates(assigns, 'sampler', checked, diags);
  const tex = all.find(s => s.name === 'Texture');
  const dim: Dim = g.type.k === 'sampler' && g.type.dim !== null ? g.type.dim : '2D';
  return {
    name, glslName: glslName(name), dim, texture: typeof tex?.value === 'string' ? tex.value : null,
    states: all.filter(s => s.name !== 'Texture'),
  };
}

function techniqueOf(node: TechniqueNode, checked: CheckedEffect, diags: Diagnostics): Technique {
  const passes: Pass[] = node.passes.map(p => ({
    name: p.name,
    annotations: annotationsOf(p.annotations, checked),
    script: scriptOf(p.annotations, checked, diags),
    states: normalizeStates(p.states, 'pass', checked, diags),
    program: emitProgram(checked, p, diags),
  }));
  return { name: node.name, annotations: annotationsOf(node.annotations, checked), script: scriptOf(node.annotations, checked, diags), passes };
}

function assemble(checked: CheckedEffect, diags: Diagnostics): EffectDesc {
  const params: Param[] = [];
  const textures: TextureDecl[] = [];
  const samplers: SamplerDecl[] = [];
  for (const [name, g] of checked.globals) {
    if (g.type.k === 'texture') {
      textures.push({
        name, type: typeName(g.type), semantic: g.decl.semantic === null ? null : g.decl.semantic.toUpperCase(),
        annotations: annotationsOf(g.decl.annotations, checked),
      });
    } else if (g.type.k === 'sampler') {
      samplers.push(samplerOf(name, g, checked, diags));
    } else {
      params.push({
        name, glslName: glslName(name), type: typeName(g.type), semantic: g.decl.semantic === null ? null : g.decl.semantic.toUpperCase(),
        storage: g.storage, annotations: annotationsOf(g.decl.annotations, checked), init: initOf(g),
      });
    }
  }
  const techniques = checked.file.items.filter((i): i is TechniqueNode => i.kind === 'technique').map(n => techniqueOf(n, checked, diags));
  return { params, textures, samplers, techniques };
}

// 前処理 → 構文解析 → 型チェック → 書き出し。例外は外に出さない
export function compileEffect(
  entry: string, readFile: (path: string) => Uint8Array | null,
  options: { defines?: Record<string, string>; listFiles?: () => string[] } = {},
): EffectResult {
  const diags = new Diagnostics();
  try {
    const tokens = preprocess(entry, { readFile, listFiles: options.listFiles }, { defines: options.defines }, diags);
    // 前処理の誤りがあれば、ここで止める (先頭の誤りが本当の原因になるように)
    if (diags.errors.length > 0) return { ok: false, errors: diags.errors, warnings: diags.warnings };
    const checked = check(parse(tokens, diags), diags);
    // 型の誤りがあれば、書き出さない (誤りが重なって出るのを避ける)
    if (diags.errors.length === 0) {
      const effect = assemble(checked, diags);
      if (diags.errors.length === 0) return { ok: true, effect, warnings: diags.warnings };
    }
  } catch (e) {
    if (!(e instanceof FxError)) {
      const message = e instanceof Error ? e.message : String(e);
      diags.errors.push({
        file: entry, line: 1, column: 1, severity: 'error', code: 'FX-INTERNAL',
        message: t('コンパイラの内部の誤りです: {message}', { message }),
      });
    }
  }
  return { ok: false, errors: diags.errors, warnings: diags.warnings };
}
