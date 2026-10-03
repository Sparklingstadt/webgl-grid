import { describe, expect, it } from 'vitest';
import { newEffector } from '../cinema4d/effectors';
import { engineWithC4d } from '../cinema4d/testing';
import { runCommand } from '../../engine/remote/commands';
import { normalizeCache, type Cache } from './Cache';

const r = (v: number) => Math.round(v * 100) / 100 + 0; // (キャッシュは小数第 4 位まで覚える)

describe('MoGraph キャッシュ', () => {
  it('焼き付けると、エフェクタを外しても焼き付けた置き場所で動く。消すと計算に戻る。元に戻せる', async () => {
    const { e, c4d } = await engineWithC4d();
    const cache = e.addons.exposed<Cache>('mograph-cache')!;
    const cube = e.world.objects[0];
    e.select(cube);
    const formula = { ...newEffector(c4d.effectors.get('formula')!), position: [0, 1, 0] as [number, number, number] };
    c4d.setCloner({ mode: 'linear', count: 4, step: [1, 0, 0], effectors: [formula] });
    e.clock.setRange(0, 30);
    e.history.checkpoint();
    const ys = () => cube.node.getObjectByName('__clones')!.children.map(g => r(g.position.y));
    const at = (f: number) => { e.clock.seekFrame(f); c4d.cloners.sync(); return ys(); };
    const live = [0, 7, 15].map(at);
    expect(cache.bake(cube)).toBe(31);
    e.history.checkpoint();
    expect(e.ui.state.history.labels.at(-1)).toBe('MoGraph キャッシュ');
    // エフェクタを外しても、焼き付けた置き場所
    c4d.setCloner({ effectors: [] });
    expect([0, 7, 15].map(at)).toEqual(live);
    // 範囲の外は端のフレーム
    expect(at(100)).toEqual(at(30));
    // 消すと計算 (エフェクタなし) に戻る
    cache.clear(cube);
    expect(at(7)).toEqual([0, 0, 0, 0]);
    // MCP
    c4d.setCloner({ effectors: [formula] });
    expect(await runCommand(e, 'run_command', { name: 'mograph-cache.bake', params: { id: cube.id } })).toMatchObject({ frames: 31 });
  });
  it('壊れたキャッシュは読まない', () => {
    expect(normalizeCache({ start: 0, count: 2, frames: [[1, 2, 3]] })).toBeNull();
    expect(normalizeCache({ start: 0, count: 1, frames: [[0, 0, 0, 0, 1, 0]] })).toEqual({ start: 0, count: 1, frames: [[0, 0, 0, 0, 1, 0]] });
  });
});
