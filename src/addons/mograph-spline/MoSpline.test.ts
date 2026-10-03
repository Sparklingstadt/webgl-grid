import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../engine/remote/commands';
import { engineWithC4d } from '../cinema4d/testing';
import type { MoSpline } from './MoSpline';

const setup = async () => {
  const { e, c4d } = await engineWithC4d();
  return { e, c4d, ms: e.addons.exposed<MoSpline>('mograph-spline')! };
};
const tube = (o: { node: THREE.Object3D }) => o.node.getObjectByName('__mospline') as THREE.Mesh | undefined;
const r = (v: number) => Math.round(v * 100) / 100 + 0;

describe('MoGraph スプライン (MoSpline)', () => {
  it('形を MoSpline にすると、管を出し (元の形は隠す)、足場と高さは曲線の大きさ。やめると戻る', async () => {
    const { e, ms } = await setup();
    const cube = e.world.objects[0];
    ms.set(cube, { bend: 0, twist: 0, length: 3, segments: 30, radius: 0.1, radiusEnd: 0.1 });
    expect(cube.mesh!.visible).toBe(false);
    expect(ms.segments(cube)).toBe(30);
    expect(r(cube.h)).toBe(3.1);
    expect(tube(cube)!.geometry.getAttribute('position').count).toBe(31 * 9);
    ms.set(cube, { radius: 0, radiusEnd: 0 }); // 太さ 0 は線
    expect((tube(cube) as unknown as { isLineSegments: boolean }).isLineSegments).toBe(true);
    ms.set(cube, null);
    expect(tube(cube)).toBeUndefined();
    expect([cube.h, cube.hx, cube.hz, cube.mesh!.visible]).toEqual([1, 0.5, 0.5, true]);
  });

  it('成長: 時刻に合わせて伸びる。場面のスプラインとして、ほかの機能から使える', async () => {
    const { e, c4d, ms } = await setup();
    const cube = e.world.objects[0];
    cube.x = 2;
    e.world.sync();
    ms.set(cube, { bend: 0, twist: 0, length: 4, segments: 40, grow: 2, growStart: 0 });
    const top = () => Math.max(...c4d.splinesOf(cube).flatMap(l => l.map(p => p.y)), 0);
    e.clock.seek(0);
    (ms as unknown as { sync(): void }).sync();
    expect(top()).toBe(0);
    e.clock.seek(1);
    (ms as unknown as { sync(): void }).sync();
    expect(r(top())).toBe(2); // 半分
    expect(c4d.splinesOf(cube)[0][0].x).toBe(2); // 場面の位置
  });

  it('クローナーの「スプライン」: 曲線にそって並べる。スプライン・エフェクタ: クローンを曲線の上へ', async () => {
    const { e, c4d, ms } = await setup();
    e.addShape(0);
    const [cloner, path] = e.world.objects;
    path.x = 5; path.z = 0;
    e.world.settle();
    e.world.sync();
    ms.set(path, { bend: 0, twist: 0, length: 4, segments: 8 });
    c4d.setCloner({ mode: 'spline', modeParams: { target: path.id, count: 5 } }, cloner);
    expect(c4d.worldLayout(cloner).map(p => [r(p.x), r(p.y), r(p.z)])).toEqual([[5, 0, 0], [5, 1, 0], [5, 2, 0], [5, 3, 0], [5, 4, 0]]);
    // 直線に並べて、スプライン・エフェクタで曲線へ
    c4d.setCloner({ mode: 'linear', count: 3, step: [1, 0, 0], effectors: [{ kind: 'spline', enabled: true, position: [0, 0, 0], rotationDeg: 0, scale: 1, params: { target: path.id, align: false }, select: '', fields: [] }] }, cloner);
    expect(c4d.worldLayout(cloner).map(p => [r(p.x), r(p.y)])).toEqual([[5, 0], [5, 2], [5, 4]]);
  });

  it('タートル: 見本の木で枝ができ、MCP で新しく置ける', async () => {
    const { e, ms } = await setup();
    const res = await runCommand(e, 'run_command', { name: 'mograph-spline.set', params: { mode: 'turtle', iterations: 2 } }) as { id: number; segments: number };
    expect(res.segments).toBeGreaterThan(20);
    expect(ms.get(e.world.find(res.id))?.mode).toBe('turtle');
  });
});
