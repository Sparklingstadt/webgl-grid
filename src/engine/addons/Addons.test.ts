import { describe, expect, it } from 'vitest';
import { BUILTIN_ADDONS } from '../../addons';
import { Engine } from '../Engine';
import { runCommand } from '../remote/commands';
import { memoryAddonStorage, type AddonModule } from './Addons';

const start = async (e = new Engine(), storage = memoryAddonStorage()) => { await e.addons.start(BUILTIN_ADDONS, storage); return e; };

describe('アドオン', () => {
  it('組み込みのアドオンは Cinema 4D だけ最初から有効で、有効にするとメニュー・パネル・命令が足され、切ると外れる', async () => {
    const e = await start();
    expect(e.ui.state.addons.map(a => [a.id, a.enabled])).toEqual([['cinema4d', true], ['turntable', false], ['float', false], ['scatter', false]]);
    const before = { menus: e.addons.menus.list().length, panels: e.addons.panels.list().length, commands: e.addons.commands.list().length, objectData: e.addons.objectData.list().length };
    await e.addons.enable('float');
    expect(e.addons.isEnabled('float')).toBe(true);
    expect(e.addons.menus.list().map(m => m.label)).toContain('ふわふわさせる / やめる');
    expect(e.addons.panels.list().map(p => p.title)).toContain('ふわふわ');
    expect(e.addons.commands.has('float.set')).toBe(true);
    expect(e.addons.objectData.has('float.bob')).toBe(true);
    e.addons.disable('float');
    expect({ menus: e.addons.menus.list().length, panels: e.addons.panels.list().length, commands: e.addons.commands.list().length, objectData: e.addons.objectData.list().length }).toEqual(before);
  });

  it('有効にしたアドオンを覚えておき、次に始めたときも有効にする。最初から有効のものも、切ったら切ったまま', async () => {
    const storage = memoryAddonStorage();
    const e = await start(new Engine(), storage);
    await e.addons.enable('turntable');
    e.addons.disable('cinema4d');
    const f = await start(new Engine(), storage);
    expect(f.addons.isEnabled('turntable')).toBe(true);
    expect(f.addons.isEnabled('float')).toBe(false);
    expect(f.addons.isEnabled('cinema4d')).toBe(false);
  });

  it('物ごとの値は、元に戻せて、プロジェクトに保存される', async () => {
    const e = await start();
    await e.addons.enable('float');
    const cube = e.world.objects[0];
    e.select(cube);
    await runCommand(e, 'run_command', { name: 'float.set', params: { height: 0.5 } });
    e.history.checkpoint();
    expect(cube.addonData?.['float.bob']).toEqual({ height: 0.5, period: 2 });
    expect(e.ui.state.history.labels.at(-1)).toBe('ふわふわ');
    await e.history.undo();
    expect(cube.addonData?.['float.bob']).toBeUndefined();
    await e.history.redo();
    expect(cube.addonData?.['float.bob']).toEqual({ height: 0.5, period: 2 });
    // 保存して開き直す (アドオンが有効なら戻る、なければ「データがある」と分かる)
    const bytes = await e.project.save('reference');
    const f = await start();
    expect((await f.project.open(bytes)).missingAddons).toEqual(['float']);
    expect(f.world.objects[0].addonData).toBeUndefined();
    await f.addons.enable('float');
    await f.project.open(bytes);
    expect(f.world.objects[0].addonData?.['float.bob']).toEqual({ height: 0.5, period: 2 });
  });

  it('場面の値は、プロジェクトに保存され、最初の状態に戻すと既定に戻る', async () => {
    const e = await start();
    await e.addons.enable('turntable');
    expect(await runCommand(e, 'run_command', { name: 'turntable.set', params: { enabled: true, degPerSec: 45 } })).toEqual({ enabled: true, degPerSec: 45 });
    const bytes = await e.project.save('reference');
    const f = await start();
    await f.addons.enable('turntable');
    await f.project.open(bytes);
    expect(await runCommand(f, 'run_command', { name: 'turntable.set', params: {} })).toEqual({ enabled: true, degPerSec: 45 });
    f.resetAll();
    expect(await runCommand(f, 'run_command', { name: 'turntable.set', params: {} })).toEqual({ enabled: false, degPerSec: 30 });
  });

  it('MCP: アドオンの一覧・有効にする・命令の一覧と実行', async () => {
    const e = await start();
    await runCommand(e, 'set_addon', { id: 'scatter', enabled: true });
    expect((await runCommand(e, 'list_commands', {}) as { addon: string }[]).filter(c => c.addon === 'scatter')).toEqual([
      { name: 'scatter.run', addon: 'scatter', description: '選んでいる形を、まわりにランダムに置く', params: expect.any(Object) },
    ]);
    e.select(e.world.objects[0]);
    const r = await runCommand(e, 'run_command', { name: 'scatter.run', params: { count: 5, seed: 3 } }) as { ids: number[] };
    expect(r.ids).toHaveLength(5);
    expect(e.world.objects).toHaveLength(6);
    await expect(runCommand(e, 'run_command', { name: 'get_state' })).rejects.toThrow('アドオンの命令 get_state はありません');
    await runCommand(e, 'set_addon', { id: 'scatter', enabled: false });
    await expect(runCommand(e, 'run_command', { name: 'scatter.run' })).rejects.toThrow('ありません');
  });

  it('register で失敗したアドオンは、足しかけたものを外して、わけを出す', async () => {
    const e = await start();
    const bad: AddonModule = {
      id: 'bad', name: 'こわれたアドオン',
      register(api) { api.addMenuItem({ menu: 'add', label: 'こわれた項目', run() {} }); throw new Error('わざと失敗'); },
    };
    e.addons.add(bad, 'installed');
    await e.addons.enable('bad');
    expect(e.addons.isEnabled('bad')).toBe(false);
    expect(e.ui.state.addons.find(a => a.id === 'bad')?.error).toBe('わざと失敗');
    expect(e.addons.menus.list().some(m => m.label === 'こわれた項目')).toBe(false);
    expect(() => e.addons.add({ ...bad, id: 'Bad Id' })).toThrow('id は');
  });
});
