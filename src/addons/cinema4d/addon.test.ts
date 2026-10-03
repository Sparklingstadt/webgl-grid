import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../engine/remote/commands';
import { newDeformer } from './deform';
import { engineWithC4d } from './testing';

const clones = (e: { world: { objects: { node: { getObjectByName(n: string): { children: unknown[] } | undefined } }[] } }) =>
  e.world.objects[0].node.getObjectByName('__clones')?.children ?? [];

describe('Cinema 4D アドオン', () => {
  it('最初から有効。切るとクローンと変形が外れ (値は覚えておく)、有効にし直すと戻る', async () => {
    const { e, c4d } = await engineWithC4d();
    expect(e.addons.isEnabled('cinema4d')).toBe(true);
    const cube = e.world.objects[0];
    const shared = cube.mesh!.geometry;
    e.select(cube);
    c4d.setCloner({ mode: 'linear', count: 3 });
    c4d.setDeformers([{ ...newDeformer('taper'), amount: -0.5 }]);
    expect(clones(e)).toHaveLength(3);
    e.addons.disable('cinema4d');
    expect(clones(e)).toHaveLength(0);
    expect(cube.mesh!.visible).toBe(true);
    expect(cube.mesh!.geometry).toBe(shared);
    expect(e.addons.exposed('cinema4d')).toBeUndefined();
    expect(e.addons.panels.list().some(p => p.title === 'クローナー')).toBe(false);
    await e.addons.enable('cinema4d');
    expect(clones(e)).toHaveLength(3);
    expect(cube.mesh!.geometry).not.toBe(shared);
  });

  it('前の版のプロジェクト (物の cloner・deformers) も開ける。アドオンが切ってあれば、データがあると分かる', async () => {
    const { e, c4d } = await engineWithC4d();
    e.select(e.world.objects[0]);
    c4d.setCloner({ mode: 'radial', count: 5 });
    c4d.setDeformers([{ ...newDeformer('bend'), amount: 30 }]);
    // 前の版の形に書き換える
    const data = JSON.parse(new TextDecoder().decode(await e.project.save('reference')));
    const so = data.objects[0];
    expect(so['cinema4d.cloner'].count).toBe(5);
    so.cloner = so['cinema4d.cloner']; so.deformers = so['cinema4d.deformers'];
    delete so['cinema4d.cloner']; delete so['cinema4d.deformers'];
    const old = strToU8(JSON.stringify(data));
    const { e: f, c4d: g } = await engineWithC4d();
    expect((await f.project.open(old)).missingAddons).toEqual([]);
    expect(g.cloner(f.world.objects[0])?.count).toBe(5);
    expect(g.deformerList(f.world.objects[0])[0].kind).toBe('bend');
    f.addons.disable('cinema4d');
    expect((await f.project.open(old)).missingAddons).toEqual(['cinema4d']);
  });

  it('MCP: 命令は cinema4d.set_cloner・set_deformers・bake_cloner', async () => {
    const { e } = await engineWithC4d();
    const id = e.world.objects[0].id;
    expect(await runCommand(e, 'run_command', { name: 'cinema4d.set_cloner', params: { id, mode: 'grid', grid: [2, 1, 2] } })).toMatchObject({ id, clones: 4 });
    expect(await runCommand(e, 'run_command', { name: 'cinema4d.set_deformers', params: { id, deformers: [{ kind: 'twist', amount: 90 }] } }))
      .toMatchObject({ deformers: [{ kind: 'twist', amount: 90 }] });
    expect(await runCommand(e, 'run_command', { name: 'cinema4d.bake_cloner', params: { id } })).toEqual({ objects: 4 });
    await expect(runCommand(e, 'set_cloner', {})).rejects.toThrow('知らない命令です');
  });
});
