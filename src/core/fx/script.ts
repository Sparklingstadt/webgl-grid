import { t } from '../i18n.ts';
import type { Diagnostics, Loc } from './diagnostics.ts';

// --- Script 注釈 (RenderColorTarget0=Map; Pass=P; …) を命令の列にする ---
export type ScriptCmdName = 'RenderColorTarget' | 'RenderDepthStencilTarget' | 'ClearSetColor' | 'ClearSetDepth' | 'ClearSetStencil'
  | 'Clear' | 'ScriptExternal' | 'Pass' | 'LoopByCount' | 'LoopEnd' | 'LoopGetIndex' | 'Draw';
export interface ScriptCommand { cmd: string; index?: number; value: string } // 知らない命令も cmd にそのまま残す

const KNOWN: ScriptCmdName[] = ['RenderColorTarget', 'RenderDepthStencilTarget', 'ClearSetColor', 'ClearSetDepth', 'ClearSetStencil',
  'Clear', 'ScriptExternal', 'Pass', 'LoopByCount', 'LoopEnd', 'LoopGetIndex', 'Draw'];
const BY_LOWER = new Map<string, ScriptCmdName>(KNOWN.map(n => [n.toLowerCase(), n]));

export function parseScript(text: string, loc: Loc, diags: Diagnostics): ScriptCommand[] {
  const cmds: ScriptCommand[] = [];
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  for (const stmt of plain.split(';')) {
    const s = stmt.trim();
    if (s === '') continue;
    const eq = s.indexOf('=');
    const lhs = (eq < 0 ? s : s.slice(0, eq)).trim();
    const value = eq < 0 ? '' : s.slice(eq + 1).trim();
    if (eq < 0) diags.warn('FX-WARN-SCRIPT', loc, t('Script の命令が 名前=値 の形ではありません: {text}', { text: s }));
    // RenderColorTarget の最後の数字は添字 (なければ 0)
    const m = /^(.*?)(\d*)$/.exec(lhs) as RegExpExecArray;
    const target = BY_LOWER.get(m[1].toLowerCase());
    if (target === 'RenderColorTarget') cmds.push({ cmd: target, index: m[2] === '' ? 0 : Number(m[2]), value });
    else {
      const known = BY_LOWER.get(lhs.toLowerCase());
      if (known === undefined && eq >= 0) diags.warn('FX-WARN-SCRIPT', loc, t('Script の命令を知りません: {name}', { name: lhs }));
      cmds.push({ cmd: known ?? lhs, value });
    }
  }
  return cmds;
}
