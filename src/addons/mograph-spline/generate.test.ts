import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { polylineLength, sampleAlong, trimPolylines, tubeGeometry } from '../cinema4d/splines';
import { boundsOf, lsystem, simpleSpline, turtleSpline } from './generate';

const r = (v: number) => Math.round(v * 100) / 100 + 0;

describe('MoSpline の曲線', () => {
  it('シンプル: 曲がりなしならまっすぐ上へ、180° 曲げると半円 (長さは同じ)、ねじると立体のらせん', () => {
    const [straight] = simpleSpline({ length: 2, segments: 10, bend: 0, twist: 0 });
    expect(straight).toHaveLength(11);
    expect(straight.at(-1)!.toArray().map(r)).toEqual([0, 2, 0]);
    const [half] = simpleSpline({ length: Math.PI, segments: 200, bend: 180, twist: 0 });
    expect(polylineLength(half)).toBeCloseTo(Math.PI, 5);
    expect(half.at(-1)!.y).toBeCloseTo(0, 1); // 半円で、床の高さに戻る
    expect(Math.abs(r(half.at(-1)!.x)) + Math.abs(r(half.at(-1)!.z))).toBeCloseTo(2, 1);
    const b = boundsOf(simpleSpline({ length: 6, segments: 200, bend: 720, twist: 360 }));
    expect(b.max.x - b.min.x).toBeGreaterThan(0.3);
    expect(b.max.z - b.min.z).toBeGreaterThan(0.3);
  });
  it('L-システム: 規則で書き換え、タートルが枝分かれした線にする', () => {
    expect(lsystem('F', 'F=F+F', 2)).toBe('F+F+F+F');
    expect(lsystem('X', 'X=F[+X]F[-X]+X; F=FF', 1)).toBe('F[+X]F[-X]+X');
    const lines = turtleSpline({ premise: 'F', rules: 'F=F[+F]F[-F]F', iterations: 2, angle: 25, step: 0.2, shrink: 1 });
    expect(lines.length).toBeGreaterThan(5); // 枝
    expect(boundsOf(lines).min.y).toBeGreaterThanOrEqual(-1e-9); // 上へ伸びる
    const straight = turtleSpline({ premise: 'FFF', rules: '', iterations: 0, angle: 90, step: 1, shrink: 1 });
    expect(straight[0].at(-1)!.toArray().map(r)).toEqual([0, 3, 0]);
    const turned = turtleSpline({ premise: 'F+F', rules: '', iterations: 0, angle: 90, step: 1, shrink: 1 });
    expect(turned[0].at(-1)!.toArray().map(r)).toEqual([-1, 1, 0]);
  });
  it('スプラインの点・切り取り・管', () => {
    const line = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 2, 0), new THREE.Vector3(2, 2, 0)];
    expect(sampleAlong([line], 0.25)!.point.toArray().map(r)).toEqual([0, 1, 0]);
    expect(sampleAlong([line], 0.75)!.tangent.toArray().map(r)).toEqual([1, 0, 0]);
    const half = trimPolylines([line], 0, 0.5);
    expect(polylineLength(half[0])).toBeCloseTo(2);
    expect(trimPolylines([line], 0.6, 0.4)).toEqual([]);
    const tube = tubeGeometry([line], 0.1, 0.05, 6);
    expect(tube.getAttribute('position').count).toBe(3 * 7);
    expect(tube.index!.count).toBe(2 * 6 * 6);
    // 管の太さ: 始めの点のまわりは半径 0.1
    const p0 = new THREE.Vector3().fromBufferAttribute(tube.getAttribute('position') as THREE.BufferAttribute, 0);
    expect(p0.length()).toBeCloseTo(0.1);
  });
});
