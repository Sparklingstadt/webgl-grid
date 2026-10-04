import { describe, expect, it } from 'vitest';
import { Diagnostics, type Loc } from './diagnostics.ts';
import { parseScript } from './script.ts';

const L: Loc = { file: 'f.fx', line: 3, column: 5 };

describe('Script の解析', () => {
  it('Script を命令の列にする (空の値・空白・最後の ; なし)', () => {
    const d = new Diagnostics();
    expect(parseScript('RenderColorTarget0=ScnMap; RenderColorTarget1=;Pass=SSDO; LoopByCount=Count', L, d)).toEqual([
      { cmd: 'RenderColorTarget', index: 0, value: 'ScnMap' }, { cmd: 'RenderColorTarget', index: 1, value: '' },
      { cmd: 'Pass', value: 'SSDO' }, { cmd: 'LoopByCount', value: 'Count' }]);
    expect(parseScript('RenderColorTarget=X;', L, d)[0]).toEqual({ cmd: 'RenderColorTarget', index: 0, value: 'X' });
    expect(d.warnings).toEqual([]);
  });

  it('改行・コメント・空の文を読み飛ばす', () => {
    const d = new Diagnostics();
    const text = 'ClearSetColor = ClearColor; // 色\n Clear = Color;;\n /* 深度 */ ClearSetDepth=ClearDepth;\r\n Clear=Depth;';
    expect(parseScript(text, L, d)).toEqual([
      { cmd: 'ClearSetColor', value: 'ClearColor' }, { cmd: 'Clear', value: 'Color' },
      { cmd: 'ClearSetDepth', value: 'ClearDepth' }, { cmd: 'Clear', value: 'Depth' }]);
    expect(d.warnings).toEqual([]);
  });

  it('命令の名前は大文字小文字を無視して表の書き方に直す', () => {
    const d = new Diagnostics();
    expect(parseScript('renderdepthstencilTarget=DepthBuffer; draw=Buffer; ScriptExternal=Color;', L, d)).toEqual([
      { cmd: 'RenderDepthStencilTarget', value: 'DepthBuffer' }, { cmd: 'Draw', value: 'Buffer' },
      { cmd: 'ScriptExternal', value: 'Color' }]);
  });

  it('LoopEnd・LoopGetIndex も読む', () => {
    const d = new Diagnostics();
    expect(parseScript('LoopByCount=N; LoopGetIndex=i; Pass=A; LoopEnd=;', L, d).map(c => c.cmd))
      .toEqual(['LoopByCount', 'LoopGetIndex', 'Pass', 'LoopEnd']);
    expect(d.warnings).toEqual([]);
  });

  it('知らない命令は FX-WARN-SCRIPT で、命令は残す', () => {
    const d = new Diagnostics();
    expect(parseScript('Foo=Bar; Pass=P;', L, d)).toEqual([{ cmd: 'Foo', value: 'Bar' }, { cmd: 'Pass', value: 'P' }]);
    expect(d.warnings.map(w => w.code)).toEqual(['FX-WARN-SCRIPT']);
    expect(d.warnings[0]).toMatchObject({ file: 'f.fx', line: 3, column: 5, severity: 'warning' });
    expect(d.errors).toEqual([]);
  });

  it('name=value の形でない文も FX-WARN-SCRIPT で残す', () => {
    const d = new Diagnostics();
    expect(parseScript('Pass', L, d)).toEqual([{ cmd: 'Pass', value: '' }]);
    expect(d.warnings.map(w => w.code)).toEqual(['FX-WARN-SCRIPT']);
  });

  it('空の Script は空の列', () => {
    const d = new Diagnostics();
    expect(parseScript('  \n ', L, d)).toEqual([]);
  });
});
