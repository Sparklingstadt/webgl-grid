import { describe, expect, it } from 'vitest';
import { compileEffect } from '../fx/index.ts';
import type { Technique } from '../fx/desc.ts';
import { runTechnique, type ScriptBackend } from './script.ts';

const SHADERS = 'float4 VS(float4 p : POSITION) : POSITION { return p; } float4 PS() : COLOR0 { return 1; }';
const pass = (name: string, script = '') => `pass ${name} ${script === '' ? '' : `< string Script = "${script}"; >`} { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); }`;

// technique T を 1 つコンパイルして取り出す
function tech(body: string, script: string): Technique {
  const src = `${SHADERS} technique T ${script === '' ? '' : `< string Script = "${script}"; >`} { ${body} }`;
  const r = compileEffect('a.fx', p => (p === 'a.fx' ? new TextEncoder().encode(src) : null));
  if (!r.ok) throw new Error(r.errors.map(e => `${e.code}: ${e.message}`).join('\n'));
  return r.effect.techniques[0];
}

// 呼ばれた順を文字列で記録する偽の backend
function fake(counts: Record<string, number> = {}) {
  const log: string[] = [];
  const backend: ScriptBackend = {
    setColorTarget: (i, n) => log.push(`color${i}=${n ?? ''}`),
    setDepthTarget: n => log.push(`depth=${n ?? ''}`),
    setClearColor: p => log.push(`clearColor=${p}`),
    setClearDepth: p => log.push(`clearDepth=${p}`),
    setClearStencil: p => log.push(`clearStencil=${p}`),
    clear: w => log.push(`clear:${w}`),
    drawPass: (p, m) => log.push(`pass:${p.name}:${m}`),
    drawExternal: () => log.push('external'),
    loopCount: p => counts[p] ?? 0,
    setLoopIndex: (p, i) => log.push(`${p}=${i}`),
    warn: m => log.push(`warn:${m}`),
  };
  return { log, backend };
}
function run(t: Technique, kind: 'object' | 'post', counts?: Record<string, number>) {
  const { log, backend } = fake(counts);
  runTechnique(t, kind, backend);
  return log;
}

const POST_FX = tech(`${pass('Blur', 'Draw=Buffer;')}`,
  'RenderColorTarget0=ScnMap; RenderDepthStencilTarget=DepthBuffer; ClearSetColor=ClearColor; Clear=Color; ScriptExternal=Color; RenderColorTarget0=; Pass=Blur;');

describe('runTechnique', () => {
  it('ポストエフェクト: 描画先・消す・ScriptExternal・pass の順', () => {
    expect(run(POST_FX, 'post')).toEqual(['color0=ScnMap', 'depth=DepthBuffer', 'clearColor=ClearColor', 'clear:color', 'external', 'color0=', 'pass:Blur:buffer']);
  });

  it('LoopByCount と LoopGetIndex (入れ子)', () => {
    const t = tech(pass('P'), 'LoopByCount=N; LoopGetIndex=I; Pass=P; LoopEnd=;');
    expect(run(t, 'object', { N: 3 })).toEqual(['I=0', 'pass:P:geometry', 'I=1', 'pass:P:geometry', 'I=2', 'pass:P:geometry']);
    const nested = tech(pass('P'), 'LoopByCount=A; LoopGetIndex=I; LoopByCount=B; LoopGetIndex=J; Pass=P; LoopEnd=; LoopEnd=;');
    expect(run(nested, 'object', { A: 2, B: 2 })).toEqual([
      'I=0', 'J=0', 'pass:P:geometry', 'J=1', 'pass:P:geometry',
      'I=1', 'J=0', 'pass:P:geometry', 'J=1', 'pass:P:geometry',
    ]);
  });

  it('LoopByCount が 0 以下ならくり返さない', () => {
    const t = tech(pass('P'), 'LoopByCount=N; Pass=P; LoopEnd=;');
    expect(run(t, 'object', { N: 0 })).toEqual([]);
    expect(run(t, 'object', { N: -2 })).toEqual([]);
  });

  it('script が空の物の technique は pass を順に Draw=Geometry で描く', () => {
    const t = tech(`${pass('A')} ${pass('B')}`, '');
    expect(run(t, 'object')).toEqual(['pass:A:geometry', 'pass:B:geometry']);
  });

  it('script が空のポストエフェクトは warn してから pass を Draw=Buffer で描く', () => {
    const log = run(tech(`${pass('A')} ${pass('B')}`, ''), 'post');
    expect(log).toHaveLength(3);
    expect(log[0]).toMatch(/^warn:/);
    expect(log.slice(1)).toEqual(['pass:A:buffer', 'pass:B:buffer']);
  });

  it('物の ScriptExternal は warn して無視', () => {
    const log = run(tech(pass('P'), 'ScriptExternal=Color; Pass=P;'), 'object');
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/^warn:/);
    expect(log[1]).toBe('pass:P:geometry');
  });

  it('pass の script の命令も実行し、Draw があればその 1 回だけ描く', () => {
    const t = tech(pass('P', 'RenderColorTarget0=X; Clear=Depth; Draw=Buffer;'), 'Pass=P;');
    expect(run(t, 'object')).toEqual(['color0=X', 'clear:depth', 'pass:P:buffer']);
  });

  it('pass の script に Draw がなければ描画の種類は kind で決まる', () => {
    const t = tech(pass('P', 'RenderColorTarget1=X;'), 'Pass=P;');
    expect(run(t, 'object')).toEqual(['color1=X', 'pass:P:geometry']);
    expect(run(t, 'post')).toEqual(['color1=X', 'pass:P:buffer']);
  });

  it('Clear・ClearSetDepth・ClearSetStencil と大文字小文字を区別しない値', () => {
    const t = tech(pass('P'), 'ClearSetDepth=D; ClearSetStencil=S; Clear=DEPTH; Clear=stencil; Pass=P;');
    expect(run(t, 'object')).toEqual(['clearDepth=D', 'clearStencil=S', 'clear:depth', 'clear:stencil', 'pass:P:geometry']);
  });

  it('同じ pass を 2 回呼んでもよい', () => {
    expect(run(tech(pass('P'), 'Pass=P; Pass=P;'), 'object')).toEqual(['pass:P:geometry', 'pass:P:geometry']);
  });

  it('知らない命令・pass の名前がない/見つからない・不正な値は warn', () => {
    const t = tech(pass('P'), 'Foo=1; Pass=; Pass=Nope; Clear=Bogus; ScriptExternal=Other; Pass=P;');
    const log = run(t, 'post');
    expect(log.filter(l => l.startsWith('warn:'))).toHaveLength(5);
    expect(log.filter(l => !l.startsWith('warn:'))).toEqual(['pass:P:buffer']);
  });

  it('対応しない LoopEnd は warn して無視', () => {
    const log = run(tech(pass('P'), 'LoopEnd=; Pass=P;'), 'object');
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/^warn:/);
    expect(log[1]).toBe('pass:P:geometry');
  });

  it('LoopEnd がなければ warn して残りをループの中身として実行する', () => {
    const log = run(tech(pass('P'), 'LoopByCount=N; Pass=P;'), 'object', { N: 2 });
    expect(log.filter(l => l.startsWith('warn:'))).toHaveLength(1);
    expect(log.filter(l => l === 'pass:P:geometry')).toHaveLength(2);
  });

  it('LoopByCount の回数は 1024 回までで warn する', () => {
    const log = run(tech(pass('P'), 'LoopByCount=N; Pass=P; LoopEnd=;'), 'object', { N: 1e9 });
    expect(log.filter(l => l === 'pass:P:geometry')).toHaveLength(1024);
    expect(log.filter(l => l.startsWith('warn:'))).toHaveLength(1);
  });

  it('LoopByCount の回数が数でなければ 0 回として warn する', () => {
    const log = run(tech(pass('P'), 'LoopByCount=N; Pass=P; LoopEnd=;'), 'object', { N: Number.NaN });
    expect(log.filter(l => l === 'pass:P:geometry')).toHaveLength(0);
    expect(log.filter(l => l.startsWith('warn:'))).toHaveLength(1);
  });

  it('ループの外の LoopGetIndex は warn して無視', () => {
    const log = run(tech(pass('P'), 'LoopGetIndex=I; Pass=P;'), 'object');
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/^warn:/);
  });
});
