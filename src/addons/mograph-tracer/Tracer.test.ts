import { describe, expect, it } from 'vitest';
import { runCommand } from '../../engine/remote/commands';
import { engineWithC4d } from '../cinema4d/testing';
import type { Tracer } from './Tracer';

const setup = async () => {
  const { e, c4d } = await engineWithC4d();
  const tr = e.addons.exposed<Tracer>('mograph-tracer')!;
  const tick = (f: number) => { e.clock.seekFrame(f, 0); (tr as unknown as { sync(): void }).sync(); };
  return { e, c4d, tr, tick };
};
const r = (v: number) => Math.round(v * 100) / 100 + 0;

describe('MoGraph トレーサー', () => {
  it('経路: フレームごとの位置を覚えて跡にし、長さのぶんだけ残す。飛ぶと取り直す', async () => {
    const { e, c4d, tr, tick } = await setup();
    const cube = e.world.objects[0];
    tr.set(cube, { length: 3 });
    for (let f = 0; f < 5; f++) { cube.x = f; e.world.sync(); tick(f); }
    const [line] = tr.lines(cube);
    expect(line.map(p => r(p.x))).toEqual([2, 3, 4]); // 最後の 3 フレーム
    expect(r(line[0].y)).toBe(0.5); // 物の真ん中の高さ
    expect(c4d.splinesOf(cube)).toHaveLength(1); // スプラインとして使える
    tick(40); // 飛ぶ
    expect(tr.lines(cube)).toHaveLength(0);
    // 跡は場面に置く (レンダリングにも写る)
    let traced = 0;
    e.graph.scene.traverse(o => { if (o.name === '__tracer') traced++; });
    expect(traced).toBe(1);
  });

  it('クローナーなら、クローンごとの跡。連結: いまの位置どうしをつなぐ', async () => {
    const { e, c4d, tr, tick } = await setup();
    const cube = e.world.objects[0];
    c4d.setCloner({ mode: 'linear', count: 3, step: [1, 0, 0] }, cube);
    tr.set(cube, {});
    for (let f = 0; f < 3; f++) { cube.z = f; e.world.sync(); tick(f); }
    expect(tr.lines(cube)).toHaveLength(3);
    expect(tr.lines(cube).map(l => l.length)).toEqual([3, 3, 3]);
    tr.set(cube, { mode: 'connect', closed: true });
    tick(3);
    expect(tr.lines(cube)).toHaveLength(1);
    expect(tr.lines(cube)[0]).toHaveLength(4); // 3 点 + 閉じる
  });

  it('やめる・物を消す・アドオンを切ると跡も消える。MCP', async () => {
    const { e, tr, tick } = await setup();
    const cube = e.world.objects[0];
    expect(await runCommand(e, 'run_command', { name: 'mograph-tracer.set', params: { id: cube.id, radius: 0 } })).toMatchObject({ points: 1 });
    tick(0); tick(1);
    const count = () => { let n = 0; e.graph.scene.traverse(o => { if (o.name === '__tracer') n++; }); return n; };
    expect(count()).toBe(1);
    e.addons.disable('mograph-tracer');
    expect(count()).toBe(0);
    await e.addons.enable('mograph-tracer');
    const tr2 = e.addons.exposed<Tracer>('mograph-tracer')!;
    (tr2 as unknown as { sync(): void }).sync();
    expect(count()).toBe(1);
    e.world.remove(cube);
    (tr2 as unknown as { sync(): void }).sync();
    expect(count()).toBe(0);
    void tr;
  });
});
