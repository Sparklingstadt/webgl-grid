import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { clip, polyfx, trianglesOf, volumeOf, voronoi, voronoiSeeds } from './voronoi';

const cube = () => trianglesOf(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
const total = (ps: { positions: Float32Array; normals: Float32Array; center: THREE.Vector3 }[]) =>
  ps.reduce((s, p) => s + volumeOf(p), 0);

describe('分割の形', () => {
  it('凸な形を平面で切ると、切り口がふさがり、体積が分かれる', () => {
    const half = clip(cube(), new THREE.Vector3(1, 0, 0), 0); // x <= 0 の側
    const piece = { center: new THREE.Vector3(), positions: new Float32Array(half.flatMap(p => p.slice(1).flatMap((_, i) => i + 2 <= p.length - 1 ? [...p[0].toArray(), ...p[i + 1].toArray(), ...p[i + 2].toArray()] : []))), normals: new Float32Array() };
    expect(volumeOf(piece)).toBeCloseTo(0.5, 5);
  });

  it('ボロノイ: 点の数だけの破片になり、体積の合計は元の形と同じ。どれも閉じた形 (体積が正)', () => {
    const tris = cube();
    const seeds = voronoiSeeds(tris, 12, 3);
    expect(seeds).toHaveLength(12);
    const pieces = voronoi(tris, seeds);
    expect(pieces).toHaveLength(12);
    expect(pieces.every(p => volumeOf(p) > 0)).toBe(true);
    expect(total(pieces)).toBeCloseTo(1, 4);
    // 中心は、元の形の中
    expect(pieces.every(p => Math.abs(p.center.x) <= 0.5 && p.center.y >= 0 && p.center.y <= 1)).toBe(true);
    // すき間を空けると、そのぶん小さくなる
    expect(total(voronoi(tris, seeds, 0.2))).toBeLessThan(0.6);
    // 同じシードなら同じ点
    expect(voronoiSeeds(tris, 5, 3).map(v => v.toArray())).toEqual(voronoiSeeds(tris, 5, 3).map(v => v.toArray()));
  });

  it('ボロノイ: 球 (たくさんの三角形) でも分けられる', () => {
    const tris = trianglesOf(new THREE.SphereGeometry(0.5, 16, 12));
    const pieces = voronoi(tris, voronoiSeeds(tris, 8, 1));
    expect(pieces).toHaveLength(8);
    expect(total(pieces)).toBeCloseTo(volumeOf({ center: new THREE.Vector3(), normals: new Float32Array(), positions: new Float32Array(tris.flatMap(t => t.flatMap(v => v.toArray()))) }), 3);
  });

  it('PolyFX: 三角形 1 枚ずつ (多すぎるときはまとめる)', () => {
    expect(polyfx(cube(), 100)).toHaveLength(12);
    expect(polyfx(cube(), 4)).toHaveLength(4);
  });
});
