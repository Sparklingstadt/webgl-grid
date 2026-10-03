import { describe, expect, it } from 'vitest';
import { encodeShiftJis } from './sjis';

const decode = (bytes: Uint8Array) => new TextDecoder('shift_jis').decode(bytes);

describe('encodeShiftJis', () => {
  it('英数字はそのまま 1 バイト', () => {
    expect([...encodeShiftJis('Bone0{')]).toEqual([...'Bone0{'].map(c => c.charCodeAt(0)));
  });
  it('全角・半角カナ・記号を含む文字列が、Shift-JIS として読み戻せる', () => {
    const s = '右足ＩＫ まばたき ｱｲｳ ①★';
    expect(decode(encodeShiftJis(s))).toBe(s);
  });
  it('全角文字は 2 バイト', () => {
    expect(encodeShiftJis('右').length).toBe(2);
  });
  it('Shift-JIS で表せない文字は ?', () => {
    expect(decode(encodeShiftJis('a😀b'))).toBe('a?b');
  });
});
