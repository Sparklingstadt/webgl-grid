import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../engine/remote/commands';
import { engineWithC4d } from '../cinema4d/testing';
import type { Extrude } from './Extrude';

const setup = async () => {
  const { e, c4d } = await engineWithC4d();
  return { e, c4d, ex: e.addons.exposed<Extrude>('mograph-extrude')! };
};
const meshOf = (o: { node: THREE.Object3D }) => o.node.getObjectByName('__moextrude') as THREE.Mesh | undefined;
const box = (m: THREE.Mesh) => { m.geometry.computeBoundingBox(); return m.geometry.boundingBox!; };
const plain = (scale: number) => ({ kind: 'plain', enabled: true, position: [0, 0, 0] as [number, number, number], rotationDeg: 0, scale, params: {}, select: '', fields: [] });

describe('MoGraph MoExtrude', () => {
  it('立方体の 6 面を押し出し (元の形は隠す)、エフェクタの大きさで長さが変わる。やめると戻る', async () => {
    const { e, ex } = await setup();
    const cube = e.world.objects[0];
    ex.set(cube, { offset: 0.5 });
    expect(ex.faceCount(cube)).toBe(6);
    expect(cube.mesh!.visible).toBe(false);
    expect(box(meshOf(cube)!).max.y).toBeCloseTo(1.5, 4);
    expect(box(meshOf(cube)!).min.x).toBeCloseTo(-1, 4);
    ex.set(cube, { effectors: [plain(2)] }); // (大きさ 2 倍 → 長さ 2 倍)
    expect(box(meshOf(cube)!).max.y).toBeCloseTo(2, 4);
    ex.set(cube, { steps: 4, capScale: 0.5 });
    expect(meshOf(cube)!.geometry.getAttribute('position').count).toBe(6 * 2 * 3 + 6 * 4 * 4 * 6);
    ex.set(cube, null);
    expect(meshOf(cube)).toBeUndefined();
    expect(cube.mesh!.visible).toBe(true);
  });

  it('元に戻す・MCP の mograph-extrude.set', async () => {
    const { e, ex } = await setup();
    const cube = e.world.objects[0];
    e.history.checkpoint();
    expect(await runCommand(e, 'run_command', { name: 'mograph-extrude.set', params: { id: cube.id, offset: 1 } })).toMatchObject({ faces: 6 });
    e.history.checkpoint();
    expect(e.ui.state.history.labels.at(-1)).toBe('MoExtrude');
    await e.history.undo();
    expect(ex.get(cube)).toBeNull();
    expect(meshOf(cube)).toBeUndefined();
  });
});
