import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { trianglesOf } from '../mograph-fracture/voronoi';
import { extrude, facesOf, vertexCount } from './geometry';

const cubeTris = () => trianglesOf(new THREE.BoxGeometry(1, 1, 1), new THREE.Matrix4());

describe('MoExtrude の形', () => {
  it('立方体の 12 個の三角形を、6 つの面 (四角形) にまとめ、まわりの辺は 4 本ずつ', () => {
    const { verts, faces } = facesOf(cubeTris());
    expect(verts.length).toBe(8);
    expect(faces.length).toBe(6);
    expect(faces.map(f => f.boundary.length)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(faces.map(f => f.tris.length)).toEqual([2, 2, 2, 2, 2, 2]);
  });
  it('押し出すと、ふたは法線の向きへ動き、壁は外を向く。頂点の数は段の数で決まる', () => {
    const { verts, faces } = facesOf(cubeTris());
    const top = faces.findIndex(f => f.normal.y > 0.9);
    const amount = faces.map((_, i) => (i === top ? 2 : 0)), shift = faces.map(() => new THREE.Vector3());
    const { positions, normals } = extrude(verts, faces, amount, shift, 0.5, 3);
    expect(positions.length).toBe(vertexCount(faces, 3) * 3);
    let maxY = -Infinity;
    for (let i = 1; i < positions.length; i += 3) maxY = Math.max(maxY, positions[i]);
    expect(maxY).toBeCloseTo(2.5); // (0.5 + 2)
    // 壁の法線は、立方体の真ん中から外へ (内積が正)
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < positions.length; i += 3) {
      p.fromArray(positions, i); n.fromArray(normals, i);
      if (Math.abs(n.y) < 0.5) expect(n.dot(new THREE.Vector3(p.x, 0, p.z))).toBeGreaterThan(-1e-6);
    }
  });
});
