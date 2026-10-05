import { describe, expect, it } from 'vitest';
import {
  binaryResultType, builtinType, componentCount, conversion, matrixOf, sameType, typeName, vectorOf,
  type Type,
} from './types.ts';

const F: Type = { k: 'scalar', s: 'float' };
const I: Type = { k: 'scalar', s: 'int' };
const F3 = vectorOf('float', 3);
const F4 = vectorOf('float', 4);
const M44 = matrixOf('float', 4, 4);
const M33 = matrixOf('float', 3, 3);

describe('型の名前', () => {
  it('キーワードから型を作る', () => {
    expect(typeName(builtinType('half4x3')!)).toBe('float4x3');
    expect(builtinType('float1')).toEqual({ k: 'scalar', s: 'float' });
    expect(builtinType('double')).toEqual(F);
    expect(builtinType('half3')).toEqual(F3);
    expect(builtinType('bool2')).toEqual({ k: 'vector', s: 'bool', n: 2 });
    expect(builtinType('uint')).toEqual({ k: 'scalar', s: 'uint' });
    expect(builtinType('sampler')).toEqual({ k: 'sampler', dim: null });
    expect(builtinType('sampler2D')).toEqual({ k: 'sampler', dim: '2D' });
    expect(builtinType('textureCUBE')).toEqual({ k: 'texture', dim: 'CUBE' });
    expect(builtinType('texture')).toEqual({ k: 'texture', dim: null });
    expect(builtinType('string')).toEqual({ k: 'string' });
    expect(builtinType('void')).toEqual({ k: 'void' });
    expect(builtinType('vector')).toEqual(F4); // 型引数なし
    expect(builtinType('matrix')).toEqual(M44);
  });
  it('型でない名前は null', () => {
    for (const n of ['float5', 'float2x', 'float5x5', 'Float', 'sampler4D', 'foo']) {
      expect(builtinType(n)).toBeNull();
    }
  });
  it('1x1 はスカラー、n = 1 のベクトルもスカラー', () => {
    expect(builtinType('float1x1')).toEqual(F);
    expect(vectorOf('int', 1)).toEqual(I);
    expect(matrixOf('float', 1, 1)).toEqual(F);
    expect(matrixOf('float', 1, 3)).toEqual({ k: 'matrix', s: 'float', rows: 1, cols: 3 });
  });
  it('書き方・同じ型・成分の数', () => {
    const arr: Type = { k: 'array', of: F4, length: 3 };
    const st: Type = { k: 'struct', name: 'S', fields: [{ name: 'a', type: F3, semantic: null }, { name: 'b', type: F, semantic: 'X' }] };
    expect(typeName(arr)).toBe('float4[3]');
    expect(typeName({ k: 'array', of: arr, length: 2 })).toBe('float4[2][3]'); // 配列の配列は書いた順
    expect(typeName(st)).toBe('S');
    expect(typeName({ k: 'sampler', dim: null })).toBe('sampler');
    expect(typeName({ k: 'sampler', dim: '3D' })).toBe('sampler3D');
    expect(sameType(arr, { k: 'array', of: F4, length: 3 })).toBe(true);
    expect(sameType(arr, { k: 'array', of: F4, length: 2 })).toBe(false);
    expect(sameType(F, I)).toBe(false);
    expect(sameType(st, { ...st, fields: [] })).toBe(true); // 構造体は名前で見る
    expect(componentCount(M44)).toBe(16);
    expect(componentCount(arr)).toBe(12);
    expect(componentCount(st)).toBe(4);
    expect(componentCount(F)).toBe(1);
  });
});

describe('型変換の cost', () => {
  it('同じ型・種類違い・広げる・切り詰める', () => {
    expect(conversion(F, F)).toEqual({ cost: 0, truncates: false });
    expect(conversion(F, I)).toEqual({ cost: 1, truncates: false });
    expect(conversion(F3, vectorOf('int', 3))).toEqual({ cost: 1, truncates: false });
    expect(conversion(F, F4)).toEqual({ cost: 2, truncates: false });
    expect(conversion(I, F4)).toEqual({ cost: 3, truncates: false });
    expect(conversion(F, M44)).toEqual({ cost: 2, truncates: false });
    expect(conversion(F4, F3)).toEqual({ cost: 4, truncates: true });
    expect(conversion(F4, F)).toEqual({ cost: 4, truncates: true });
    expect(conversion(F3, F4)).toBeNull();
    expect(conversion(M44, M33)).toEqual({ cost: 4, truncates: true });
    expect(conversion(M33, M44)).toBeNull();
    expect(conversion(M44, matrixOf('float', 3, 4))).toEqual({ cost: 4, truncates: true });
    expect(conversion(matrixOf('float', 2, 4), matrixOf('float', 4, 2))).toBeNull();
  });
  it('成分の数が同じベクトルと行列は 5', () => {
    expect(conversion(F4, matrixOf('float', 2, 2))).toEqual({ cost: 5, truncates: false });
    expect(conversion(matrixOf('float', 2, 2), F4)).toEqual({ cost: 5, truncates: false });
    expect(conversion(F3, matrixOf('float', 2, 2))).toBeNull();
  });
  it('構造体・配列は同じ型だけ', () => {
    const s1: Type = { k: 'struct', name: 'A', fields: [] };
    const s2: Type = { k: 'struct', name: 'B', fields: [] };
    expect(conversion(s1, s1)).toEqual({ cost: 0, truncates: false });
    expect(conversion(s1, s2)).toBeNull();
    const a3: Type = { k: 'array', of: F, length: 3 };
    expect(conversion(a3, { k: 'array', of: F, length: 4 })).toBeNull();
    expect(conversion(F, a3)).toBeNull();
    expect(conversion(s1, F)).toBeNull();
  });
  it('sampler (dim null) はどの dim とも 0', () => {
    const any: Type = { k: 'sampler', dim: null };
    const s2d: Type = { k: 'sampler', dim: '2D' };
    expect(conversion(any, s2d)).toEqual({ cost: 0, truncates: false });
    expect(conversion(s2d, any)).toEqual({ cost: 0, truncates: false });
    expect(conversion(s2d, { k: 'sampler', dim: 'CUBE' })).toBeNull();
    expect(conversion(any, F)).toBeNull();
  });
});

describe('二項演算の結果', () => {
  it('算術', () => {
    expect(binaryResultType('+', F4, F)?.type).toEqual(F4);
    expect(binaryResultType('-', F, F4)).toEqual({ type: F4, truncates: false });
    expect(binaryResultType('*', F4, F3)).toEqual({ type: F3, truncates: true });
    expect(binaryResultType('/', F3, F3)).toEqual({ type: F3, truncates: false });
    expect(binaryResultType('*', M44, M44)?.type).toEqual(M44); // 成分ごと
    expect(binaryResultType('*', M44, M33)).toEqual({ type: M33, truncates: true });
    expect(binaryResultType('+', M44, F)?.type).toEqual(M44);
    expect(binaryResultType('*', matrixOf('float', 2, 4), matrixOf('float', 4, 2)))
      .toEqual({ type: matrixOf('float', 2, 2), truncates: true });
  });
  it('成分の種類', () => {
    expect(binaryResultType('+', I, F)?.type).toEqual(F);
    expect(binaryResultType('+', vectorOf('int', 3), I)?.type).toEqual(vectorOf('int', 3));
    expect(binaryResultType('+', { k: 'scalar', s: 'bool' }, { k: 'scalar', s: 'bool' })?.type).toEqual(I);
    expect(binaryResultType('%', I, { k: 'scalar', s: 'uint' })?.type).toEqual({ k: 'scalar', s: 'uint' });
  });
  it('比較と論理は同じ形の bool', () => {
    expect(binaryResultType('<', F3, F3)?.type).toEqual(vectorOf('bool', 3));
    expect(binaryResultType('==', F, F4)?.type).toEqual(vectorOf('bool', 4));
    expect(binaryResultType('&&', I, I)?.type).toEqual({ k: 'scalar', s: 'bool' });
    expect(binaryResultType('!=', M44, M44)?.type).toEqual(matrixOf('bool', 4, 4));
    expect(binaryResultType('<=', F4, F3)).toEqual({ type: vectorOf('bool', 3), truncates: true });
  });
  it('使えない組み合わせは null', () => {
    expect(binaryResultType('&', I, I)).toBeNull();
    expect(binaryResultType('<<', I, I)).toBeNull();
    expect(binaryResultType('+', F4, M44)).toBeNull();
    expect(binaryResultType('+', { k: 'string' }, F)).toBeNull();
    expect(binaryResultType('+', { k: 'struct', name: 'S', fields: [] }, F)).toBeNull();
  });
});
