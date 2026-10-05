import type { Pass, Technique } from '../fx/desc.ts';
import type { ScriptCommand } from '../fx/script.ts';
import { t } from '../i18n.ts';

// --- technique / pass の Script を抽象 backend に対して実行する ---
export interface ScriptBackend {
  setColorTarget(index: number, name: string | null): void; // '' は null (既定の描画先)
  setDepthTarget(name: string | null): void;
  setClearColor(param: string): void;
  setClearDepth(param: string): void;
  setClearStencil(param: string): void;
  clear(what: 'color' | 'depth' | 'stencil'): void;
  drawPass(pass: Pass, mode: 'geometry' | 'buffer'): void;
  drawExternal(): void; // ScriptExternal=Color
  loopCount(param: string): number; // LoopByCount の回数 (パラメータの値を整数に)
  setLoopIndex(param: string, i: number): void; // LoopGetIndex
  warn(message: string): void;
}

const MAX_LOOP = 1024; // 暴走を止める LoopByCount の上限

interface Ctx { tech: Technique; kind: 'object' | 'post'; backend: ScriptBackend; loops: number[]; pass: Pass | null }

export function runTechnique(tech: Technique, kind: 'object' | 'post', backend: ScriptBackend): void {
  const ctx: Ctx = { tech, kind, backend, loops: [], pass: null };
  if (tech.script.length > 0) { exec(tech.script, ctx); return; }
  if (kind === 'post') backend.warn(t('ポストエフェクトの technique に Script がありません。pass を順に描きます'));
  for (const p of tech.passes) runPass(p, ctx);
}

// pass の script を実行する (Draw がなければ最後に 1 回描く)
function runPass(pass: Pass, ctx: Ctx): void {
  const sub: Ctx = { ...ctx, loops: [], pass };
  exec(pass.script, sub);
  if (!pass.script.some(c => c.cmd === 'Draw')) ctx.backend.drawPass(pass, ctx.kind === 'post' ? 'buffer' : 'geometry');
}

// LoopByCount (cmds[from]) に対応する LoopEnd の位置 (なければ -1)
function matchingEnd(cmds: ScriptCommand[], from: number): number {
  let depth = 0;
  for (let i = from; i < cmds.length; i++) {
    if (cmds[i].cmd === 'LoopByCount') depth++;
    else if (cmds[i].cmd === 'LoopEnd' && --depth === 0) return i;
  }
  return -1;
}

function exec(cmds: ScriptCommand[], ctx: Ctx): void {
  const { backend } = ctx;
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    const v = c.value;
    switch (c.cmd) {
      case 'RenderColorTarget': backend.setColorTarget(c.index ?? 0, v === '' ? null : v); break;
      case 'RenderDepthStencilTarget': backend.setDepthTarget(v === '' ? null : v); break;
      case 'ClearSetColor': backend.setClearColor(v); break;
      case 'ClearSetDepth': backend.setClearDepth(v); break;
      case 'ClearSetStencil': backend.setClearStencil(v); break;
      case 'Clear': {
        const what = v.toLowerCase();
        if (what === 'color' || what === 'depth' || what === 'stencil') backend.clear(what);
        else backend.warn(t('Clear の値を知りません: {value}', { value: v }));
        break;
      }
      case 'ScriptExternal':
        if (v.toLowerCase() !== 'color') backend.warn(t('ScriptExternal の値を知りません: {value}', { value: v }));
        else if (ctx.kind === 'post') backend.drawExternal();
        else backend.warn(t('ScriptExternal=Color はポストエフェクトでだけ使えます。無視します'));
        break;
      case 'Pass': {
        const pass = v === '' ? undefined : ctx.tech.passes.find(p => p.name === v);
        if (ctx.pass !== null) backend.warn(t('pass の Script の中の Pass は使えません。無視します'));
        else if (pass === undefined) backend.warn(v === '' ? t('Pass に名前がありません') : t('Pass が見つかりません: {name}', { name: v }));
        else runPass(pass, ctx);
        break;
      }
      case 'Draw': {
        const mode = v.toLowerCase();
        if (ctx.pass === null) backend.warn(t('Draw は pass の Script の中でだけ使えます。無視します'));
        else if (mode === 'geometry' || mode === 'buffer') backend.drawPass(ctx.pass, mode);
        else backend.warn(t('Draw の値を知りません: {value}', { value: v }));
        break;
      }
      case 'LoopByCount': {
        let end = matchingEnd(cmds, i);
        if (end < 0) { backend.warn(t('LoopByCount に対応する LoopEnd がありません')); end = cmds.length; }
        let n = backend.loopCount(v);
        if (!Number.isFinite(n)) { backend.warn(t('LoopByCount の回数が数ではありません: {value}', { value: v })); n = 0; }
        n = Math.floor(n);
        if (n > MAX_LOOP) { backend.warn(t('LoopByCount の回数が多すぎます: {n} ({max} 回までにします)', { n, max: MAX_LOOP })); n = MAX_LOOP; }
        const body = cmds.slice(i + 1, end);
        for (let k = 0; k < n; k++) {
          ctx.loops.push(k);
          exec(body, ctx);
          ctx.loops.pop();
        }
        i = end;
        break;
      }
      case 'LoopEnd': backend.warn(t('LoopEnd に対応する LoopByCount がありません。無視します')); break;
      case 'LoopGetIndex':
        if (ctx.loops.length === 0) backend.warn(t('LoopGetIndex はループの中でだけ使えます。無視します'));
        else backend.setLoopIndex(v, ctx.loops[ctx.loops.length - 1]);
        break;
      default: backend.warn(t('Script の命令を知りません: {cmd}', { cmd: c.cmd }));
    }
  }
}
