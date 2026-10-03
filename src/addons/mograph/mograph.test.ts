import { describe, expect, it } from 'vitest';
import { CLONER_DEFAULT, clonerLayout, normalizeCloner, type ClonerSettings } from '../cinema4d/cloner';
import { newEffector, type LayoutEnv } from '../cinema4d/effectors';
import { engineWithC4d } from '../cinema4d/testing';
import { EFFECTORS } from '.';

const def = (k: string) => EFFECTORS.find(d => d.key === k)!;
const eff = (k: string, patch: object = {}) => ({ ...newEffector(def(k)), ...patch });
const env = (time = 0, origin = { x: 0, y: 0, z: 0, r: 0 }): LayoutEnv => ({ effector: k => EFFECTORS.find(d => d.key === k), time, origin });
const r = (v: number) => Math.round(v * 100) / 100 + 0;
const line = (effectors: ClonerSettings['effectors'], count = 3): ClonerSettings =>
  normalizeCloner({ ...CLONER_DEFAULT, mode: 'linear', count, step: [1, 0, 0], effectors });

describe('MoGraph エフェクタ', () => {
  it('プレーンは全部に同じだけ、ステップは最初の 0 から最後の値まで、ディレイは 1 つごとに遅らせる。重ねると上から順に', () => {
    expect(clonerLayout(line([eff('plain', { position: [0, 1, 0], scale: 2 })]), 100, env()).map(p => [r(p.y), r(p.scale)])).toEqual([[1, 2], [1, 2], [1, 2]]);
    expect(clonerLayout(line([eff('step', { rotationDeg: 90, scale: 3 })]), 100, env()).map(p => [r(p.ry), r(p.scale)])).toEqual([[0, 1], [0.79, 2], [1.57, 3]]);
    const delay = clonerLayout(line([eff('delay', { params: { frames: 4 } }), eff('delay', { params: { frames: 1 }, enabled: false })]), 100, env());
    expect(delay.map(p => p.delay)).toEqual([0, 4, 8]);
    expect(clonerLayout(line([eff('plain', { scale: 2 }), eff('step', { scale: 2 })]), 100, env()).map(p => r(p.scale))).toEqual([2, 3, 4]);
  });

  it('ランダム: クローンごとにばらつき、範囲に収まり、同じシードなら同じ', () => {
    const a = clonerLayout(line([eff('random', { position: [1, 0, 1], rotationDeg: 0, params: { seed: 3 } })], 20), 100, env());
    const b = clonerLayout(line([eff('random', { position: [1, 0, 1], rotationDeg: 0, params: { seed: 3 } })], 20), 100, env());
    const c = clonerLayout(line([eff('random', { position: [1, 0, 1], rotationDeg: 0, params: { seed: 4 } })], 20), 100, env());
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.every((p, i) => Math.abs(p.x - i) <= 1 && Math.abs(p.z) <= 1 && p.y === 0)).toBe(true);
    expect(new Set(a.map(p => r(p.z))).size).toBeGreaterThan(10);
  });

  it('フォーミュラ: 番号と時刻で波のように (sin)。タイム: 時刻 (秒) に合わせて強く', () => {
    const f = (t: number) => clonerLayout(line([eff('formula', { position: [0, 1, 0] })], 4), 100, env(t)).map(p => r(p.y));
    expect(f(0)).toEqual([0, 1, 0, -1]);
    expect(f(0.25)).toEqual([1, 0, -1, 0]); // 1 Hz で 1/4 周ずれる
    const t = clonerLayout(line([eff('time', { rotationDeg: 90 })], 2), 100, env(2)).map(p => r(p.ry));
    expect(t).toEqual([r(Math.PI), r(Math.PI)]);
  });

  it('ターゲット: クローンを決めた場所へ向ける (クローナーの位置と向きも考える)', () => {
    const toward = (o: { x: number; z: number; r: number }, origin = { ...o, y: 0 }) =>
      clonerLayout(line([eff('target', { params: { x: 1, z: 5 } })], 2), 100, env(0, origin)).map(p => r(p.ry));
    expect(toward({ x: 0, z: 0, r: 0 })).toEqual([r(Math.atan2(1, 5)), 0]);
    // クローナーを (1, 5) から見て真後ろへ回すと、向きは逆に
    expect(Math.abs(toward({ x: 1, z: 0, r: Math.PI })[0])).toBeCloseTo(Math.PI, 2);
  });

  it('時刻で変わるエフェクタは、描く前に置き場所を並べ直す', async () => {
    const { e, c4d } = await engineWithC4d();
    e.select(e.world.objects[0]);
    c4d.setCloner({ mode: 'linear', count: 4, step: [1, 0, 0], effectors: [eff('formula', { position: [0, 1, 0] })] });
    const ys = () => e.world.objects[0].node.getObjectByName('__clones')!.children.map(g => r(g.position.y));
    expect(ys()).toEqual([0, 1, 0, -1]);
    e.clock.seek(0.25);
    c4d.cloners.sync();
    expect(ys()).toEqual([1, 0, -1, 0]);
  });

  it('Cinema 4D が必要: 一緒に最初から有効。Cinema 4D を切ると一緒に切れ、有効にすると Cinema 4D も有効になる', async () => {
    const { e, c4d } = await engineWithC4d();
    expect(e.addons.isEnabled('mograph')).toBe(true);
    expect(c4d.effectors.list().map(d => d.key)).toEqual(['plain', 'step', 'random', 'formula', 'time', 'target', 'delay']);
    // エフェクタを切っても、クローナーの設定は残る (かからないだけ)
    e.select(e.world.objects[0]);
    c4d.setCloner({ mode: 'linear', count: 2, effectors: [eff('plain', { position: [0, 2, 0] })] });
    const y = () => e.world.objects[0].node.getObjectByName('__clones')!.children[0].position.y;
    expect(y()).toBe(2);
    e.addons.disable('mograph');
    expect(c4d.effectors.list()).toEqual([]);
    expect(y()).toBe(0);
    expect(c4d.cloner(e.world.objects[0])!.effectors).toHaveLength(1);
    await e.addons.enable('mograph');
    expect(y()).toBe(2);
    e.addons.disable('cinema4d');
    expect(e.addons.isEnabled('mograph')).toBe(false);
    await e.addons.enable('mograph');
    expect(e.addons.isEnabled('cinema4d')).toBe(true);
    expect(e.ui.state.addons.find(a => a.id === 'mograph')?.requires).toEqual(['cinema4d']);
  });
});
