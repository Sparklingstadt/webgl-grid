import { describe, expect, it } from 'vitest';
import { addDictionary, setLang } from '../i18n.ts';
import en from '../../i18n/en.ts';
import { matchName, parseDefaultEffect, resolveDefault } from './defaultEffect.ts';

// Ray-MMD の実物: 隣り合う文字列リテラルをコンパイラが連結したあとの形
const RAY = 'self = hide;*controller*.pmx=hide;*= ./Materials/material_2.0.fx;';

describe('parseDefaultEffect', () => {
  it('Ray-MMD の実物を、順番どおり 3 つの規則にする', () => {
    const { rules, warnings } = parseDefaultEffect(RAY);
    expect(warnings).toEqual([]);
    expect(rules.map(r => r.pattern)).toEqual(['self', '*controller*.pmx', '*']);
    expect(rules[0].action).toEqual({ kind: 'hide' });
    expect(rules[1].action).toEqual({ kind: 'hide' });
    expect(rules[2].action).toEqual({ kind: 'effect', path: 'Materials/material_2.0.fx' });
  });
  it('hide・none は大文字小文字を無視する。none は none', () => {
    const { rules } = parseDefaultEffect('a=none;b=HIDE;c = None');
    expect(rules.map(r => r.action)).toEqual([{ kind: 'none' }, { kind: 'hide' }, { kind: 'none' }]);
  });
  it('パスは normalizePath を通す (\\ や ./ や ..)', () => {
    const { rules } = parseDefaultEffect('a=.\\Mat\\..\\x\\m.fx');
    expect(rules[0].action).toEqual({ kind: 'effect', path: 'x/m.fx' });
  });
  it('= のない項は警告して捨てる', () => {
    const { rules, warnings } = parseDefaultEffect('broken');
    expect(rules).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
  it('空の項・パターンか動作が空の項も警告して捨てる。最後の ; のあとは警告しない', () => {
    const { rules, warnings } = parseDefaultEffect('a=hide;;=hide;b=;c=hide;');
    expect(rules.map(r => r.pattern)).toEqual(['a', 'c']);
    expect(warnings).toHaveLength(3);
  });
  it('空の文字列は規則も警告もない', () => {
    expect(parseDefaultEffect('')).toEqual({ rules: [], warnings: [] });
    expect(parseDefaultEffect('  ')).toEqual({ rules: [], warnings: [] });
  });
  it('警告は t() を通る', () => {
    addDictionary('en', en);
    setLang('en');
    try {
      const { warnings } = parseDefaultEffect('broken');
      expect(warnings[0]).toMatch(/broken/);
      expect(warnings[0]).not.toMatch(/[ぁ-ん]/);
    } finally {
      setLang('ja');
    }
  });
});

describe('matchName', () => {
  it('* は 0 文字以上、? は 1 文字、大文字小文字を無視、全体一致', () => {
    expect(matchName('sky*box*.*', 'Sky with box.pmx')).toBe(true);
    expect(matchName('*controller*.pmx', 'ray_controller.pmx')).toBe(true);
    expect(matchName('PointLight.pmx', 'pointlight.PMX')).toBe(true);
    expect(matchName('a?c', 'abbc')).toBe(false);
    expect(matchName('a?c', 'abc')).toBe(true);
    expect(matchName('a*', 'a')).toBe(true);
    expect(matchName('ab', 'abc')).toBe(false);
    expect(matchName('b', 'abc')).toBe(false);
  });
  it('正規表現の記号は文字として扱う', () => {
    expect(matchName('a.b', 'axb')).toBe(false);
    expect(matchName('a.b', 'a.b')).toBe(true);
    expect(matchName('(a)+[b]', '(a)+[b]')).toBe(true);
  });
  it('改行を含む名前にも * が合う', () => {
    expect(matchName('a*c', 'a\nb\nc')).toBe(true);
  });
});

describe('resolveDefault', () => {
  const { rules } = parseDefaultEffect(RAY);
  it('上から順。self は isSelf のときだけ合う', () => {
    expect(resolveDefault(rules, 'ray_controller.pmx', false)).toEqual({ kind: 'hide' });
    expect(resolveDefault(rules, 'ミク.pmx', true)).toEqual({ kind: 'hide' });
    expect(resolveDefault(rules, 'ミク.pmx', false)).toEqual({ kind: 'effect', path: 'Materials/material_2.0.fx' });
  });
  it('self は大文字小文字を無視する。isSelf でなければ名前 "self" とも合わない扱いにはしない', () => {
    const { rules: r } = parseDefaultEffect('SELF=hide;*=a.fx');
    expect(resolveDefault(r, 'x', true)).toEqual({ kind: 'hide' });
    expect(resolveDefault(r, 'x', false)).toEqual({ kind: 'effect', path: 'a.fx' });
  });
  it('どれにも合わなければ null、none は none', () => {
    expect(resolveDefault(parseDefaultEffect('a.pmx=hide').rules, 'b.pmx', false)).toBeNull();
    expect(resolveDefault(parseDefaultEffect('a=none').rules, 'a', false)).toEqual({ kind: 'none' });
    expect(resolveDefault([], 'a', true)).toBeNull();
  });
});
