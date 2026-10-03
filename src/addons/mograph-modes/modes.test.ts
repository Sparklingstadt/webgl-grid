import { describe, expect, it } from 'vitest';
import { engineWithC4d } from '../cinema4d/testing';
import { honeycomb } from '.';

const r = (v: number) => Math.round(v * 100) / 100 + 0;

describe('MoGraph 配置', () => {
  it('ハニカム: 1 段おきに半分ずらし、段の間は間隔 × √3/2', () => {
    const l = honeycomb({ width: 2, height: 2, spacing: 1, plane: 'xy' }, 100);
    expect(l.map(p => [r(p.x), r(p.y), r(p.z)])).toEqual([[-0.5, 0, 0], [0.5, 0, 0], [0, 0.87, 0], [1, 0.87, 0]]);
    expect(honeycomb({ width: 3, height: 3, spacing: 1, plane: 'xz' }, 100).every(p => p.y === 0)).toBe(true);
    expect(honeycomb({ width: 10, height: 10, spacing: 1, plane: 'xz' }, 7)).toHaveLength(7);
  });

  it('オブジェクト: ほかの物の頂点・表面・中身に並べ、その物を動かすとついていく', async () => {
    const { e, c4d } = await engineWithC4d();
    e.addShape(0); // 2 つ目の立方体 (並べる先)
    const [cloner, target] = e.world.objects;
    target.x = 5; target.z = 0;
    e.world.settle();
    e.world.sync();
    c4d.setCloner({ mode: 'object', modeParams: { target: target.id, distribution: 'vertices' } }, cloner);
    const world = () => c4d.worldLayout(cloner);
    // 立方体の頂点 (同じ場所の頂点も数える) は、x = 4.5〜5.5・y = 0〜1 の角
    expect(world().length).toBeGreaterThan(7);
    expect(world().every(p => [4.5, 5.5].includes(r(p.x)) && [0, 1].includes(r(p.y)) && [-0.5, 0.5].includes(r(p.z)))).toBe(true);
    // 表面: 数のとおり、面の上
    c4d.setCloner({ modeParams: { target: target.id, distribution: 'surface', count: 30 } }, cloner);
    expect(world()).toHaveLength(30);
    const onFace = (p: { x: number; y: number; z: number }) => [Math.abs(p.x - 5) - 0.5, Math.abs(p.y - 0.5) - 0.5, Math.abs(p.z) - 0.5].some(d => Math.abs(d) < 1e-3);
    expect(world().every(onFace)).toBe(true);
    // 中身: 箱の中
    c4d.setCloner({ modeParams: { target: target.id, distribution: 'volume', count: 20 } }, cloner);
    expect(world().length).toBeGreaterThan(10);
    expect(world().every(p => Math.abs(p.x - 5) <= 0.5 && p.y >= 0 && p.y <= 1 && Math.abs(p.z) <= 0.5)).toBe(true);
    // 並べる先を動かすと、ついていく
    target.z = 3;
    e.world.sync();
    expect(world().every(p => Math.abs(p.z - 3) <= 0.5)).toBe(true);
    // MoGraph 配置を切ると、並べない (設定は残る)
    e.addons.disable('mograph-modes');
    expect(c4d.count(cloner)).toBe(0);
    expect(c4d.cloner(cloner)?.mode).toBe('object');
  });
});
