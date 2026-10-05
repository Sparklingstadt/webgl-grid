import { describe, expect, it } from 'vitest';
import { encodeShiftJis } from '../sjis.ts';
import { decodeSource, dirname, joinPath, normalizePath, resolveFile } from './source.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);
const utf16 = (s: string, le: boolean) => {
  const out = new Uint8Array(2 + s.length * 2);
  out.set(le ? [0xff, 0xfe] : [0xfe, 0xff]);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = le ? c & 0xff : c >> 8;
    out[3 + i * 2] = le ? c >> 8 : c & 0xff;
  }
  return out;
};

describe('ソースの読み方', () => {
  it('BOM 付きの UTF-8・UTF-16LE・UTF-16BE を読む', () => {
    expect(decodeSource(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('ab')]))).toBe('ab');
    expect(decodeSource(utf16('ab', true))).toBe('ab');
    expect(decodeSource(utf16('ab', false))).toBe('ab');
  });
  it('BOM なしの UTF-8 を読む', () => {
    expect(decodeSource(utf8('// 明るさ'))).toBe('// 明るさ');
  });
  it('UTF-8 として正しくなければ Shift-JIS として読む', () => {
    expect(decodeSource(encodeShiftJis('// 明るさ\r\nfloat a;'))).toBe('// 明るさ\nfloat a;');
  });
  it('CR だけの改行も \\n にする', () => expect(decodeSource(utf8('a\rb'))).toBe('a\nb'));
  it('CRLF は 1 つの \\n にする', () => expect(decodeSource(utf8('a\r\nb\r\n'))).toBe('a\nb\n'));
});

describe('パス', () => {
  it('正規化する', () => {
    expect(normalizePath('Shader\\..\\shader\\.\\math.fxsub')).toBe('shader/math.fxsub');
    expect(normalizePath('../a//b')).toBe('../a/b');
    expect(normalizePath('./a/b')).toBe('a/b');
    expect(normalizePath('../../a/../b')).toBe('../../b');
    expect(joinPath('Materials/Editor', '../../material_common_2.0.fxsub')).toBe('material_common_2.0.fxsub');
    expect(joinPath('', 'a/b.fx')).toBe('a/b.fx');
    expect(dirname('a/b/c.fx')).toBe('a/b');
    expect(dirname('c.fx')).toBe('');
  });
  it('書かれたとおりになければ、大文字小文字を無視して listFiles から探す', () => {
    const files: Record<string, Uint8Array> = { 'Shader/Math.fxsub': utf8('x') };
    const access = { readFile: (p: string) => files[p] ?? null, listFiles: () => Object.keys(files) };
    expect(resolveFile(access, 'x\\..\\shader\\math.FXSUB')?.path).toBe('Shader/Math.fxsub');
    expect(resolveFile(access, 'Shader/Math.fxsub')?.path).toBe('Shader/Math.fxsub');
    expect(resolveFile(access, 'nothing.fx')).toBeNull();
    expect(resolveFile({ readFile: access.readFile }, 'shader/math.fxsub')).toBeNull(); // listFiles がなければ探さない
  });
});
