import { describe, expect, it } from 'vitest';
import { isIntrinsic, resolveIntrinsic, UNSUPPORTED_INTRINSICS } from './intrinsics.ts';
import { matrixOf, vectorOf, type Type } from './types.ts';

const F: Type = { k: 'scalar', s: 'float' };
const I: Type = { k: 'scalar', s: 'int' };
const F2 = vectorOf('float', 2);
const F3 = vectorOf('float', 3);
const F4 = vectorOf('float', 4);
const M44 = matrixOf('float', 4, 4);
const M33 = matrixOf('float', 3, 3);
const SAMPLER: Type = { k: 'sampler', dim: null };
const B = (n: number) => vectorOf('bool', n);

describe('組み込み関数の名前', () => {
  it('表にある名前だけが組み込み関数', () => {
    for (const n of ['lerp', 'mul', 'tex2D', 'tex2Dlod', 'texCUBEbias', 'tex3Dproj', 'tex1Dgrad', 'D3DCOLORtoUBYTE4', 'saturate']) {
      expect(isIntrinsic(n), n).toBe(true);
    }
    for (const n of ['noise', 'frexp', 'dst', 'foo', 'tex2Dfoo', 'mix', 'texture']) {
      expect(isIntrinsic(n), n).toBe(false);
    }
    expect(UNSUPPORTED_INTRINSICS).toEqual(['noise', 'frexp', 'dst']);
  });
});

describe('mul のかたち', () => {
  it('ベクトルと行列・行列の積・内積', () => {
    expect(resolveIntrinsic('mul', [F4, matrixOf('float', 4, 3)])).toMatchObject({ ok: true, ret: F3 });
    expect(resolveIntrinsic('mul', [matrixOf('float', 3, 4), F4])).toMatchObject({ ok: true, ret: F3 });
    expect(resolveIntrinsic('mul', [F3, F3])).toMatchObject({ ok: true, ret: F });
    expect(resolveIntrinsic('mul', [M44, M44])).toMatchObject({ ok: true, ret: M44 });
    expect(resolveIntrinsic('mul', [matrixOf('float', 2, 3), matrixOf('float', 3, 4)]))
      .toMatchObject({ ok: true, ret: matrixOf('float', 2, 4) });
    expect(resolveIntrinsic('mul', [F4, M44])).toEqual({ ok: true, ret: F4, params: [F4, M44] });
  });
  it('スカラーとの積', () => {
    expect(resolveIntrinsic('mul', [F, F3])).toMatchObject({ ok: true, ret: F3 });
    expect(resolveIntrinsic('mul', [M44, F])).toMatchObject({ ok: true, ret: M44 });
    expect(resolveIntrinsic('mul', [F, F])).toMatchObject({ ok: true, ret: F });
  });
  it('合わないものは no-overload', () => {
    expect(resolveIntrinsic('mul', [M44])).toEqual({ ok: false, reason: 'no-overload' });
    expect(resolveIntrinsic('mul', [{ k: 'string' }, F3])).toEqual({ ok: false, reason: 'no-overload' });
  });
  it('内側の大きさが合わなければ大きいほうを切り詰める', () => {
    expect(resolveIntrinsic('mul', [F3, M44])).toEqual({ ok: true, ret: F4, params: [F3, matrixOf('float', 3, 4)] });
    expect(resolveIntrinsic('mul', [F4, M33])).toEqual({ ok: true, ret: F3, params: [F3, M33] });
    expect(resolveIntrinsic('mul', [M44, F3])).toEqual({ ok: true, ret: F4, params: [matrixOf('float', 4, 3), F3] });
    expect(resolveIntrinsic('mul', [M44, M33]))
      .toEqual({ ok: true, ret: matrixOf('float', 4, 3), params: [matrixOf('float', 4, 3), M33] });
    expect(resolveIntrinsic('mul', [F3, F4])).toEqual({ ok: true, ret: F, params: [F3, F3] });
  });
  it('float と float1x3 の積は float1x3、int の引数は float にする', () => {
    const m13 = matrixOf('float', 1, 3);
    expect(resolveIntrinsic('mul', [F, m13])).toEqual({ ok: true, ret: m13, params: [F, m13] });
    expect(resolveIntrinsic('mul', [m13, F])).toEqual({ ok: true, ret: m13, params: [m13, F] });
    expect(resolveIntrinsic('mul', [vectorOf('int', 3), M33])).toMatchObject({ ok: true, ret: F3, params: [F3, M33] });
  });
});

describe('広げてから選ぶ', () => {
  it('lerp のスカラー引数は広げる', () => {
    expect(resolveIntrinsic('lerp', [F3, F3, F])).toMatchObject({ ok: true, ret: F3, params: [F3, F3, F3] });
    expect(resolveIntrinsic('lerp', [F, F4, F])).toMatchObject({ ok: true, ret: F4, params: [F4, F4, F4] });
  });
  it('dot は切り詰めて選ぶ', () => {
    expect(resolveIntrinsic('dot', [F3, F4])).toMatchObject({ ok: true, ret: F, params: [F3, F3] });
    expect(resolveIntrinsic('dot', [F4, F4])).toMatchObject({ ok: true, ret: F });
  });
  it('int は float に直して選ぶ・int 版がある関数は int のまま', () => {
    expect(resolveIntrinsic('sin', [I])).toMatchObject({ ok: true, ret: F, params: [F] });
    expect(resolveIntrinsic('abs', [I])).toMatchObject({ ok: true, ret: I });
    expect(resolveIntrinsic('max', [vectorOf('int', 2), vectorOf('int', 2)])).toMatchObject({ ok: true, ret: vectorOf('int', 2) });
    expect(resolveIntrinsic('max', [I, F])).toMatchObject({ ok: true, ret: F, params: [F, F] });
    expect(resolveIntrinsic('clamp', [F3, F, F])).toMatchObject({ ok: true, ret: F3, params: [F3, F3, F3] });
  });
  it('行列も成分ごとの関数に渡せる', () => {
    expect(resolveIntrinsic('saturate', [M33])).toMatchObject({ ok: true, ret: M33 });
    expect(resolveIntrinsic('pow', [M44, F])).toMatchObject({ ok: true, ret: M44 });
  });
  it('uint と bool は int 版を選ぶ', () => {
    const U: Type = { k: 'scalar', s: 'uint' };
    const BS: Type = { k: 'scalar', s: 'bool' };
    expect(resolveIntrinsic('abs', [U])).toEqual({ ok: true, ret: I, params: [I] });
    expect(resolveIntrinsic('min', [U, U])).toEqual({ ok: true, ret: I, params: [I, I] });
    expect(resolveIntrinsic('abs', [BS])).toEqual({ ok: true, ret: I, params: [I] });
    expect(resolveIntrinsic('max', [vectorOf('uint', 3), vectorOf('uint', 3)])).toMatchObject({ ok: true, ret: vectorOf('int', 3) });
  });
  it('float を落とす候補は選ばない', () => {
    expect(resolveIntrinsic('clamp', [I, I, F])).toEqual({ ok: true, ret: F, params: [F, F, F] });
  });
  it('Object.prototype の名前は組み込み関数ではない', () => {
    for (const n of ['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf']) {
      expect(isIntrinsic(n), n).toBe(false);
      expect(resolveIntrinsic(n, [F]), n).toEqual({ ok: false, reason: 'no-overload' });
    }
  });
  it('スカラーを広げるほうを、切り詰めるより先に選ぶ', () => {
    expect(resolveIntrinsic('lerp', [F, F4, F])).toMatchObject({ ok: true, ret: F4 });
    expect(resolveIntrinsic('clamp', [F3, F, F])).toMatchObject({ ok: true, ret: F3 });
  });
  it('引数の数が違えば no-overload', () => {
    expect(resolveIntrinsic('lerp', [F3, F3])).toEqual({ ok: false, reason: 'no-overload' });
    expect(resolveIntrinsic('sin', [F, F])).toEqual({ ok: false, reason: 'no-overload' });
    expect(resolveIntrinsic('nothing', [F])).toEqual({ ok: false, reason: 'no-overload' });
  });
  it('構造体などは渡せない', () => {
    const st: Type = { k: 'struct', name: 'S', fields: [] };
    expect(resolveIntrinsic('sin', [st])).toEqual({ ok: false, reason: 'no-overload' });
    expect(resolveIntrinsic('dot', [SAMPLER, SAMPLER])).toEqual({ ok: false, reason: 'no-overload' });
  });
  it('同点が 2 つ以上なら ambiguous', () => {
    // float3x4 は float2x2 にも float3x3 にも同じ cost で切り詰められる
    expect(resolveIntrinsic('determinant', [matrixOf('float', 3, 4)])).toEqual({ ok: false, reason: 'ambiguous' });
  });
});

describe('ベクトル用・特別な関数', () => {
  it('ベクトル用', () => {
    expect(resolveIntrinsic('length', [F3])).toMatchObject({ ok: true, ret: F });
    expect(resolveIntrinsic('distance', [F2, F2])).toMatchObject({ ok: true, ret: F });
    expect(resolveIntrinsic('normalize', [F3])).toMatchObject({ ok: true, ret: F3 });
    expect(resolveIntrinsic('reflect', [F3, F3])).toMatchObject({ ok: true, ret: F3 });
    expect(resolveIntrinsic('refract', [F3, F3, F])).toMatchObject({ ok: true, ret: F3, params: [F3, F3, F] });
    expect(resolveIntrinsic('faceforward', [F3, F3, F3])).toMatchObject({ ok: true, ret: F3 });
  });
  it('cross は float3 だけ', () => {
    expect(resolveIntrinsic('cross', [F3, F3])).toMatchObject({ ok: true, ret: F3 });
    expect(resolveIntrinsic('cross', [F4, F4])).toMatchObject({ ok: true, ret: F3, params: [F3, F3] });
    expect(resolveIntrinsic('cross', [F2, F2])).toEqual({ ok: false, reason: 'no-overload' });
  });
  it('all / any / isnan / clip', () => {
    expect(resolveIntrinsic('all', [B(3)])).toMatchObject({ ok: true, ret: { k: 'scalar', s: 'bool' } });
    expect(resolveIntrinsic('any', [F4])).toMatchObject({ ok: true, ret: { k: 'scalar', s: 'bool' }, params: [F4] });
    expect(resolveIntrinsic('isnan', [F3])).toMatchObject({ ok: true, ret: B(3) });
    expect(resolveIntrinsic('isfinite', [F])).toMatchObject({ ok: true, ret: { k: 'scalar', s: 'bool' } });
    expect(resolveIntrinsic('clip', [F3])).toMatchObject({ ok: true, ret: { k: 'void' } });
  });
  it('sincos・modf・lit・determinant・transpose・D3DCOLORtoUBYTE4', () => {
    expect(resolveIntrinsic('sincos', [F3, F3, F3])).toMatchObject({ ok: true, ret: { k: 'void' }, params: [F3, F3, F3] });
    expect(resolveIntrinsic('modf', [F3, F3])).toMatchObject({ ok: true, ret: F3 });
    expect(resolveIntrinsic('lit', [F, F, F])).toMatchObject({ ok: true, ret: F4 });
    expect(resolveIntrinsic('determinant', [M33])).toMatchObject({ ok: true, ret: F });
    expect(resolveIntrinsic('transpose', [F4])).toEqual({ ok: false, reason: 'no-overload' }); // ベクトルは取らない
    expect(resolveIntrinsic('determinant', [F])).toEqual({ ok: false, reason: 'no-overload' });
    expect(resolveIntrinsic('transpose', [matrixOf('float', 3, 4)])).toMatchObject({ ok: true, ret: matrixOf('float', 4, 3) });
    expect(resolveIntrinsic('D3DCOLORtoUBYTE4', [F4])).toMatchObject({ ok: true, ret: vectorOf('int', 4) });
  });
});

describe('テクスチャ', () => {
  it('sampler (dim null) はどの tex でも使える', () => {
    expect(resolveIntrinsic('tex2D', [SAMPLER, F2])).toMatchObject({ ok: true, ret: F4 });
    expect(resolveIntrinsic('texCUBE', [SAMPLER, F3])).toMatchObject({ ok: true, ret: F4 });
    expect(resolveIntrinsic('tex3D', [SAMPLER, F3])).toMatchObject({ ok: true, ret: F4 });
    expect(resolveIntrinsic('tex1D', [SAMPLER, F])).toMatchObject({ ok: true, ret: F4 });
  });
  it('dim が合わなければ no-overload', () => {
    expect(resolveIntrinsic('texCUBE', [{ k: 'sampler', dim: '2D' }, F3])).toEqual({ ok: false, reason: 'no-overload' });
    expect(resolveIntrinsic('tex2D', [{ k: 'sampler', dim: '2D' }, F2])).toMatchObject({ ok: true, ret: F4 });
    expect(resolveIntrinsic('tex2D', [{ k: 'texture', dim: '2D' }, F2])).toEqual({ ok: false, reason: 'no-overload' });
  });
  it('座標は切り詰める', () => {
    expect(resolveIntrinsic('tex2D', [SAMPLER, F4])).toMatchObject({ ok: true, params: [{ k: 'sampler', dim: '2D' }, F2] });
  });
  it('lod / bias / proj は float4、grad は 4 引数', () => {
    for (const n of ['tex2Dlod', 'tex2Dbias', 'tex2Dproj', 'texCUBElod', 'tex3Dbias', 'tex1Dproj']) {
      expect(resolveIntrinsic(n, [SAMPLER, F4]), n).toMatchObject({ ok: true, ret: F4 });
    }
    expect(resolveIntrinsic('tex2Dlod', [SAMPLER, F2])).toEqual({ ok: false, reason: 'no-overload' });
    expect(resolveIntrinsic('tex2D', [SAMPLER, F2, F2, F2])).toMatchObject({ ok: true, ret: F4 });
    expect(resolveIntrinsic('tex2Dgrad', [SAMPLER, F2, F2, F2])).toMatchObject({ ok: true, ret: F4 });
    expect(resolveIntrinsic('texCUBE', [SAMPLER, F3, F3, F3])).toMatchObject({ ok: true, ret: F4 });
    expect(resolveIntrinsic('tex2D', [SAMPLER, F2, F2])).toEqual({ ok: false, reason: 'no-overload' });
  });
});
