import { describe, expect, it } from 'vitest';
import { runCommand } from '../../engine/remote/commands';
import { engineWithC4d } from '../cinema4d/testing';
import { normalizeText, type MoText } from './MoText';

const setup = async () => {
  const { e, c4d } = await engineWithC4d();
  return { e, c4d, mt: e.addons.exposed<MoText>('mograph-text')! };
};

describe('MoGraph テキスト (MoText)', () => {
  it('形をテキストにすると、元の形を隠し、足場と高さを文字の大きさにする。やめると戻る', async () => {
    const { e, mt } = await setup();
    const cube = e.world.objects[0];
    mt.set(cube, { text: 'ABCD', size: 2 });
    expect(cube.mesh!.visible).toBe(false);
    expect(mt.count(cube)).toBe(4); // 文字ごと
    expect(cube.hx).toBeGreaterThan(1);
    expect(cube.h).toBeGreaterThan(1.5);
    mt.set(cube, { unit: 'all' });
    expect(mt.count(cube)).toBe(1);
    mt.set(cube, null);
    expect(cube.mesh!.visible).toBe(true);
    expect([cube.h, cube.hx, cube.hz]).toEqual([1, 0.5, 0.5]);
  });

  it('単語・行ごと。元に戻す・プロジェクト・アドオンを切ると元の形', async () => {
    const { e, mt } = await setup();
    const cube = e.world.objects[0];
    mt.set(cube, { text: 'ab cd\nef', unit: 'words' });
    expect(mt.count(cube)).toBe(3);
    e.history.checkpoint();
    expect(e.ui.state.history.labels.at(-1)).toBe('テキスト');
    await e.history.undo();
    expect(mt.count(cube)).toBe(0);
    await e.history.redo();
    mt.set(cube, { unit: 'lines' });
    expect(mt.count(cube)).toBe(2);
    const bytes = await e.project.save('reference');
    const { e: f, mt: g } = await setup();
    await f.project.open(bytes);
    expect(g.get(f.world.objects[0])?.text).toBe('ab cd\nef');
    expect(g.count(f.world.objects[0])).toBe(2);
    e.addons.disable('mograph-text');
    expect(cube.mesh!.visible).toBe(true);
    expect(cube.h).toBe(1);
  });

  it('設定をそろえる (フォントの名前に記号は入れない)', () => {
    expect(normalizeText({ font: 'x; color: red', size: 999, unit: 'pages' as never })).toMatchObject({ font: 'sans-serif', size: 20, unit: 'letters' });
  });

  it('MCP: mograph-text.set で新しく置いて、文字を変える', async () => {
    const { e } = await setup();
    const r = await runCommand(e, 'run_command', { name: 'mograph-text.set', params: { text: 'Hi' } }) as { id: number; units: number };
    expect(e.world.objects).toHaveLength(2);
    expect(r.units).toBe(2);
    expect(await runCommand(e, 'run_command', { name: 'mograph-text.set', params: { id: r.id, text: 'Hello', unit: 'all' } })).toMatchObject({ units: 1 });
  });
});
