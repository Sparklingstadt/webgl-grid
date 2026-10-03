import { describe, expect, it } from 'vitest';
import { defaultParams, type FieldContext } from '../cinema4d/effectors';
import { engineWithC4d } from '../cinema4d/testing';
import { FIELDS } from './fields';

const field = (k: string) => FIELDS.find(f => f.key === k)!;
const at = (k: string, p: [number, number, number], params: object = {}, time = 0, rnd = 0.3) => {
  const def = field(k);
  const ctx: FieldContext = { index: 0, count: 1, time, params: { ...defaultParams(def.params), ...params }, random: () => rnd };
  return Math.round(def.value({ x: p[0], y: p[1], z: p[2] }, ctx) * 100) / 100;
};

describe('MoGraph フィールド', () => {
  it('リニア: 軸にそって 0 → 1', () => {
    expect([at('linear', [-2, 0, 0]), at('linear', [0, 0, 0]), at('linear', [2, 0, 0])]).toEqual([0, 0.5, 1]);
    expect(at('linear', [0, 3, 0], { axis: 'y', length: 2, cy: 2 })).toBe(1);
  });
  it('球・ボックス・円柱: 内側は 1、外は 0、あいだはなめらか', () => {
    expect([at('sphere', [0, 1, 0]), at('sphere', [0.9, 1, 0]), at('sphere', [1.5, 1, 0]), at('sphere', [3, 1, 0])]).toEqual([1, 1, 0.5, 0]);
    expect([at('box', [0, 1, 0]), at('box', [1.4, 1, 0]), at('box', [0, 1, 2])]).toEqual([1, 0.05, 0]);
    expect([at('cylinder', [0, 1, 0]), at('cylinder', [0, 3, 0]), at('cylinder', [2.5, 1, 0])]).toEqual([1, 0, 0]);
  });
  it('放射・ランダム・ノイズ・タイム', () => {
    expect([at('radial', [0, 0, 1]), at('radial', [1, 0, 0]), at('radial', [0, 0, -1])]).toEqual([0, 0.25, 0.5]);
    expect(at('random', [0, 0, 0], {}, 0, 0.42)).toBe(0.42);
    const n = [at('noise', [0, 0, 0]), at('noise', [0.3, 0, 0]), at('noise', [5, 0, 0])];
    expect(n.every(v => v >= 0 && v <= 1)).toBe(true);
    expect(Math.abs(n[0] - n[1])).toBeLessThan(0.3); // 近い所は近い値
    expect(at('noise', [0, 0, 0], { speed: 1 }, 0)).not.toBe(at('noise', [0, 0, 0], { speed: 1 }, 1.3)); // 速さで流れる
    expect([at('time', [0, 0, 0], {}, 0), at('time', [0, 0, 0], {}, 1.5), at('time', [0, 0, 0], {}, 9)]).toEqual([0, 0.5, 1]);
  });
  it('アドオン: 最初から有効でフィールドを登録する。切るとフィールドは効かない', async () => {
    const { e, c4d } = await engineWithC4d();
    expect(c4d.fields.list().map(f => f.key)).toEqual(['linear', 'sphere', 'box', 'cylinder', 'radial', 'random', 'noise', 'time']);
    e.select(e.world.objects[0]);
    c4d.setCloner({
      mode: 'grid', grid: [5, 1, 1], spacing: [1, 1, 1],
      effectors: [{ kind: 'plain', enabled: true, position: [0, 1, 0], rotationDeg: 0, scale: 1, params: {}, select: '',
        fields: [{ kind: 'sphere', enabled: true, blend: 'normal', opacity: 1, invert: false, params: { cx: 2, cy: 0, cz: 0, radius: 1.5, inner: 0 } }] }],
    });
    const ys = () => e.world.objects[0].node.getObjectByName('__clones')!.children.map(g => Math.round(g.position.y * 100) / 100);
    expect(ys()).toEqual([0, 0, 0, 0.26, 1]); // 球の中心 (x = 2) に近いほど強い
    // 切ると、フィールドは効かない (エフェクタは全体に効く)
    e.addons.disable('mograph-fields');
    expect(ys()).toEqual([1, 1, 1, 1, 1]);
  });
});
