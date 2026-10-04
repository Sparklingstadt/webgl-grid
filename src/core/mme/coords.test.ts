import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3, Vector4 } from 'three';
import { groundShadowMatrix, orthoD3D, perspectiveD3D, toMmd, toMmdVec, viewLH } from './coords.ts';

const close = (a: number[]) => a.map(n => expect.closeTo(n, 6));

describe('MME の座標', () => {
  it('elements は D3D の行ごとの並び (mul(v, D) = 列ベクトルの M·v)', () => {
    const m = new Matrix4().makeRotationY(0.3).setPosition(1, 2, 3);
    const v = [0.5, -1, 2, 1], d = m.elements;
    const hlsl = [0, 1, 2, 3].map(c => v.reduce((s, vi, r) => s + vi * d[r * 4 + c], 0)); // mul(v, D): D[r][c] = d[r*4+c]
    expect(hlsl).toEqual(close(new Vector4(...v).applyMatrix4(m).toArray()));
  });

  it('toMmd: three.js の (0, 0, 1) は MMD の z = −1、平行移動の z も反転', () => {
    expect(toMmdVec(new Vector3(0, 0, 1)).z).toBe(-1);
    expect(new Vector3(0, 0, 0).applyMatrix4(toMmd(new Matrix4().makeTranslation(1, 2, 3))).toArray()).toEqual([1, 2, -3]);
  });

  it('toMmd: 元の行列を変えず、y 軸の回転の向きが反転する', () => {
    const m = new Matrix4().makeRotationY(0.5);
    const before = m.toArray();
    const r = toMmd(m);
    expect(m.toArray()).toEqual(before);
    // 右手系で x → −z に回る向きが、左手系では x → +z になる
    expect(new Vector3(1, 0, 0).applyMatrix4(r).toArray()).toEqual(close([Math.cos(0.5), 0, Math.sin(0.5)]));
    expect(new Vector3(1, 0, 0).applyMatrix4(m).toArray()).toEqual(close([Math.cos(0.5), 0, -Math.sin(0.5)]));
  });

  it('toMmdVec: 元のベクトルを変えない', () => {
    const v = new Vector3(1, 2, 3);
    expect(toMmdVec(v).toArray()).toEqual([1, 2, -3]);
    expect(v.toArray()).toEqual([1, 2, 3]);
  });

  it('perspectiveD3D: near → z/w = 0、far → 1、右が +x', () => {
    const p = perspectiveD3D(Math.PI / 2, 2, 1, 11);
    const ndc = (x: number, y: number, z: number) => {
      const c = new Vector4(x, y, z, 1).applyMatrix4(p);
      return [c.x / c.w, c.y / c.w, c.z / c.w];
    };
    expect(ndc(0, 0, 1)[2]).toBeCloseTo(0, 6);
    expect(ndc(0, 0, 11)[2]).toBeCloseTo(1, 6);
    expect(ndc(0, 0, 6)[2]).toBeGreaterThan(0.5); // 深度は非線形 (遠いほど 1 に寄る)
    // fov 90°・aspect 2: 視野の縦半分は z、横半分は 2z
    expect(ndc(2, 1, 1)).toEqual(close([1, 1, 0]));
    expect(ndc(1, 0, 1)[0]).toBeCloseTo(0.5, 6);
    expect(ndc(1, 0, 1)[0]).toBeGreaterThan(0);
  });

  it('orthoD3D: near → 0、far → 1、範囲の端が ±1', () => {
    const o = orthoD3D(-2, 6, -1, 3, 1, 5);
    expect(new Vector3(-2, -1, 1).applyMatrix4(o).toArray()).toEqual(close([-1, -1, 0]));
    expect(new Vector3(6, 3, 5).applyMatrix4(o).toArray()).toEqual(close([1, 1, 1]));
    expect(new Vector3(2, 1, 3).applyMatrix4(o).toArray()).toEqual(close([0, 0, 0.5]));
  });

  it('viewLH: 目の前の点は視野の +z', () => {
    const v = viewLH(new Vector3(0, 0, -10), new Vector3(0, 0, 0), new Vector3(0, 1, 0));
    expect(new Vector3(0, 0, 0).applyMatrix4(v).toArray()).toEqual(close([0, 0, 10]));
    // 左手系: +x は画面の右、+y は上
    expect(new Vector3(1, 2, 0).applyMatrix4(v).toArray()).toEqual(close([1, 2, 10]));
  });

  it('viewLH: 斜めの視線でも目は原点・視線は +z', () => {
    const eye = new Vector3(3, 4, -5), target = new Vector3(-1, 0, 2);
    const v = viewLH(eye, target, new Vector3(0, 1, 0));
    expect(eye.clone().applyMatrix4(v).toArray()).toEqual(close([0, 0, 0]));
    const t = target.clone().applyMatrix4(v);
    expect(t.x).toBeCloseTo(0, 6);
    expect(t.y).toBeCloseTo(0, 6);
    expect(t.z).toBeCloseTo(eye.distanceTo(target), 6);
  });

  it('viewLH × perspectiveD3D: 目の前の点が NDC の中心、右の点は x > 0', () => {
    const view = viewLH(new Vector3(0, 0, -10), new Vector3(0, 0, 0), new Vector3(0, 1, 0));
    const vp = perspectiveD3D(0.8, 1.5, 0.1, 100).multiply(view);
    expect(new Vector3(0, 0, 0).applyMatrix4(vp).toArray().slice(0, 2)).toEqual(close([0, 0]));
    expect(new Vector3(1, 0, 0).applyMatrix4(vp).x).toBeGreaterThan(0);
  });

  it('groundShadowMatrix: 光の向きに沿って y = 0.01 に潰れる', () => {
    const p = new Vector3(1, 2, 3).applyMatrix4(groundShadowMatrix(new Vector3(-1, -1, 0).normalize()));
    expect(p.toArray()).toEqual(close([-1, 0.01, 3]));
  });

  it('groundShadowMatrix: z 成分も追い、向きの長さによらない', () => {
    const p = new Vector3(0, 2, 0).applyMatrix4(groundShadowMatrix(new Vector3(1, -2, -3)));
    expect(p.toArray()).toEqual(close([1, 0.01, -3]));
  });

  it('groundShadowMatrix: y を渡すとその高さの面に潰し、さらに 0.01 持ち上げる', () => {
    const p = new Vector3(1, 3, 0).applyMatrix4(groundShadowMatrix(new Vector3(-1, -1, 0), 1));
    expect(p.toArray()).toEqual(close([-1, 1.01, 0]));
  });

  it('groundShadowMatrix: 光がほぼ水平 (または上向き) でも有限', () => {
    for (const y of [0, -1e-9, 0.5]) {
      const m = groundShadowMatrix(new Vector3(1, y, 0));
      expect(m.elements.every(Number.isFinite)).toBe(true);
    }
  });
});
