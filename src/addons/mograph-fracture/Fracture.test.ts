import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../engine/remote/commands';
import { engineWithC4d } from '../cinema4d/testing';
import type { Fracture } from './Fracture';

const setup = async () => {
  const { e, c4d } = await engineWithC4d();
  return { e, c4d, fr: e.addons.exposed<Fracture>('mograph-fracture')! };
};
const pieces = (o: { node: THREE.Object3D }) => o.node.getObjectByName('__fracture') as THREE.Mesh | undefined;
const box = (m: THREE.Mesh) => { m.geometry.computeBoundingBox(); return m.geometry.boundingBox!; };
const plain = (y: number) => ({ kind: 'plain', enabled: true, position: [0, y, 0] as [number, number, number], rotationDeg: 0, scale: 1, params: {}, select: '', fields: [] });

describe('MoGraph 分割', () => {
  it('ボロノイ: 立方体を破片に分け (元の形は隠す)、エフェクタで破片を動かす。やめると戻る', async () => {
    const { e, fr } = await setup();
    const cube = e.world.objects[0];
    fr.set(cube, { count: 8, gap: 0 });
    expect(fr.count(cube)).toBe(8);
    expect(cube.mesh!.visible).toBe(false);
    const m = pieces(cube)!;
    expect(box(m).min.y).toBeCloseTo(0, 4);
    expect(box(m).max.y).toBeCloseTo(1, 4);
    fr.set(cube, { effectors: [plain(2)] });
    expect(box(pieces(cube)!).min.y).toBeCloseTo(2, 4);
    fr.set(cube, null);
    expect(pieces(cube)).toBeUndefined();
    expect(cube.mesh!.visible).toBe(true);
  });

  it('PolyFX は面ごと。凸でない形 (トーラス) はボロノイにできず、わけを出す', async () => {
    const { e, fr } = await setup();
    fr.set(e.world.objects[0], { mode: 'polyfx', count: 100 });
    expect(fr.count(e.world.objects[0])).toBe(12);
    e.addShape(1); // トーラス
    const torus = e.world.objects[1];
    fr.set(torus, {});
    expect(fr.count(torus)).toBe(0);
    expect(fr.problems.get(torus)).toMatch(/凸でない/);
    expect(torus.mesh!.visible).toBe(true);
    fr.set(torus, { mode: 'polyfx' });
    expect(fr.count(torus)).toBeGreaterThan(10);
  });

  it('元に戻す・プロジェクト・アドオンを切ると元の形 (設定は残る)', async () => {
    const { e, fr } = await setup();
    const cube = e.world.objects[0];
    fr.set(cube, { count: 5 });
    e.history.checkpoint();
    expect(e.ui.state.history.labels.at(-1)).toBe('分割');
    await e.history.undo();
    expect(pieces(cube)).toBeUndefined();
    await e.history.redo();
    expect(fr.count(cube)).toBe(5);
    const bytes = await e.project.save('reference');
    const { e: f, fr: g } = await setup();
    await f.project.open(bytes);
    expect(g.count(f.world.objects[0])).toBe(5);
    e.addons.disable('mograph-fracture');
    expect(pieces(cube)).toBeUndefined();
    expect(cube.mesh!.visible).toBe(true);
    await e.addons.enable('mograph-fracture');
    expect(e.addons.exposed<Fracture>('mograph-fracture')!.count(cube)).toBe(5);
  });

  it('MCP: mograph-fracture.set', async () => {
    const { e } = await setup();
    const id = e.world.objects[0].id;
    expect(await runCommand(e, 'run_command', { name: 'mograph-fracture.set', params: { id, count: 6 } })).toMatchObject({ id, pieces: 6 });
    expect(await runCommand(e, 'run_command', { name: 'mograph-fracture.set', params: { id, off: true } })).toMatchObject({ fracture: null, pieces: 0 });
  });
});
