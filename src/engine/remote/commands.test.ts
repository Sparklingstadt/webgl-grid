import { describe, expect, it } from 'vitest';
import { Engine } from '../Engine';
import { runCommand } from './commands';

// 描画先なしのエンジンで、外部 (MCP) からの命令を確かめる
describe('外部からの命令', () => {
  it('形を置き、動かし (積み重ね)、色を変え、消す', async () => {
    const e = new Engine();
    const { id } = await runCommand(e, 'add_shape', { shape: 'pyramid', x: 4, z: 2, color: '青' }) as { id: number };
    let s = await runCommand(e, 'get_state', {}) as { objects: { id: number; name: string; position: number[]; color: string }[]; selected: number };
    expect(s.objects.find(o => o.id === id)).toMatchObject({ name: '三角錐', position: [4, 0, 2], color: '青' });
    expect(s.selected).toBe(id);
    await runCommand(e, 'set_object', { id: 1, x: 4, z: 2, color: 5 });
    s = await runCommand(e, 'get_state', {}) as typeof s;
    expect(s.objects.find(o => o.id === 1)).toMatchObject({ color: '緑' });
    expect(Math.max(...s.objects.map(o => o.position[1]))).toBeGreaterThan(0); // 同じ場所なので、どちらかが上に積まれた
    await runCommand(e, 'delete_object', { id });
    expect(e.world.objects.map(o => o.id)).toEqual([1]);
  });
  it('タイムラインと形のマテリアル', async () => {
    const e = new Engine();
    expect(await runCommand(e, 'timeline', { start: 10, end: 40, frame: 20 })).toMatchObject({ start: 10, end: 40, frame: 20 });
    await runCommand(e, 'set_material', { id: 1, inputs: { baseColor: '#00ff00', metallic: 1 }, name: '金属' });
    const m = (await runCommand(e, 'list_materials', {}) as { name: string; inputs: Record<string, unknown> }[]).find(m => m.name === '金属')!;
    expect(m.inputs).toMatchObject({ baseColor: '#00ff00', metallic: 1 });
  });
  it('分からない命令・ない物・モデルがないときは、分かるエラー', async () => {
    const e = new Engine();
    await expect(runCommand(e, 'rm_rf', {})).rejects.toThrow('知らない命令です');
    await expect(runCommand(e, 'toString', {})).rejects.toThrow('知らない命令です');
    await expect(runCommand(e, 'set_object', { id: 99, x: 1 })).rejects.toThrow('id 99 の物はありません');
    await expect(runCommand(e, 'set_bone', { bone: '右腕', rotationDeg: [0, 0, 1] })).rejects.toThrow('MMD モデルではありません');
    await expect(runCommand(e, 'add_shape', { shape: 'dodecahedron' })).rejects.toThrow('形は');
  });
});
