import { describe, expect, it } from 'vitest';
import { evaluate, keyFrames } from '../../core/animation';
import type { Obj } from '../types';
import { engineWithCube } from '../testEngine';
import { mmeChannel } from './mmeChannels';

// MME のチャンネル: 物ごとの名前の一覧 (mmeChannels) の番号でキーを持ち、いまの値は mmeValues (名前 → 値)
describe('MME のチャンネルのキーフレーム', () => {
  it('名前のチャンネルは、なければ後ろに足して番号を返す (消さない・並べ替えない)', () => {
    const e = engineWithCube();
    const cube = e.world.objects[0];
    expect(mmeChannel(cube, 'Si')).toBe(0);
    expect(mmeChannel(cube, 'SSAO+')).toBe(1);
    expect(mmeChannel(cube, 'Si')).toBe(0);
    expect(cube.mmeChannels).toEqual(['Si', 'SSAO+']);
  });

  it('mmeValues の値でキーを打ち、あいだのフレームでは補間した値を mmeValues に書く。値が変わったときだけ知らせる', () => {
    const e = engineWithCube();
    const cube = e.world.objects[0];
    cube.mmeValues = { Si: 1, Tr: 0.5 };
    e.keyframes.insertMme(cube, 0, ['Si']);
    cube.mmeValues.Si = 3;
    e.keyframes.insertMme(cube, 30, ['Si']);
    expect(cube.mmeChannels).toEqual(['Si']);
    expect(keyFrames(cube.anim)).toEqual([0, 30]);
    expect(evaluate(cube.anim!, 15).mme.get(0)).toBeCloseTo(2);
    const told: Obj[][] = [];
    e.keyframes.events.on('mmeChanged', objs => told.push(objs));
    e.clock.seekFrame(15);
    expect(cube.mmeValues.Si).toBeCloseTo(2);
    expect(cube.mmeValues.Tr).toBe(0.5); // (キーのない値はそのまま)
    expect(told).toEqual([[cube]]);
    e.keyframes.applyAll(e.clock.t, true); // (同じフレーム: 値は変わらない)
    expect(told.length).toBe(1);
    // 打ち直すと値だけ替わる。mmeValues にない名前は打たない
    cube.anim!.mme.get(0)!.get(30)!.curve = [0.42, 0, 0.58, 1];
    cube.mmeValues.Si = 5;
    e.keyframes.insertMme(cube, 30, ['Si', 'X']);
    expect(cube.anim!.mme.get(0)!.get(30)).toEqual({ v: 5, curve: [0.42, 0, 0.58, 1] });
    expect(cube.mmeChannels).toEqual(['Si']);
  });

  it('タイムラインを広げると、チャンネルの名前の行が出る', () => {
    const e = engineWithCube();
    const cube = e.world.objects[0];
    e.select(cube);
    cube.mmeValues = { 'SSAO+': 0.25 };
    e.keyframes.insertMme(cube, 4, ['SSAO+']);
    e.keyframes.setExpanded(true);
    expect(e.timelineRows().map(r => [r.label, r.keys, r.channel])).toEqual([['立方体', [4], undefined], ['MME: SSAO+', [4], { kind: 'mme', index: 0 }]]);
  });

  it('コピーしたキーは、同じ名前の値を持つほかの物へも貼れる', () => {
    const e = engineWithCube();
    e.addShape(0);
    const [a, b] = e.world.objects;
    a.mmeValues = { Si: 2 };
    e.keyframes.insertMme(a, 0, ['Si']);
    e.keyframes.select([0], false);
    expect(e.keyframes.copy(a)).toBe(true);
    expect(e.keyframes.paste(b, 10, 0)).toBe(false); // (b には Si の値がない)
    b.mmeValues = { X: 0, Si: 1 };
    expect(e.keyframes.paste(b, 10, 0)).toBe(true);
    expect(b.mmeChannels).toEqual(['Si']);
    expect(b.anim!.mme.get(0)!.get(10)!.v).toBe(2);
  });

  it('元に戻すとキー・チャンネル・値が戻り、再生しただけでは手にならない', async () => {
    const e = engineWithCube();
    const cube = e.world.objects[0];
    cube.mmeValues = { Si: 1 };
    e.history.checkpoint();
    e.keyframes.insertMme(cube, 0, ['Si']);
    e.clock.seekFrame(30); // (キーのある値は、動かすとそのフレームの値になるので、動かしてから変える)
    cube.mmeValues.Si = 3;
    e.keyframes.insertMme(cube, 30, ['Si']);
    e.history.checkpoint();
    const steps = e.ui.state.history.labels.length;
    e.clock.seekFrame(15);
    e.history.checkpoint();
    expect(e.ui.state.history.labels.length).toBe(steps);
    await e.history.undo();
    expect([cube.anim ?? null, cube.mmeChannels, cube.mmeValues]).toEqual([null, undefined, { Si: 1 }]);
    await e.history.redo();
    expect(cube.mmeChannels).toEqual(['Si']);
    expect(cube.mmeValues!.Si).toBeCloseTo(2); // (いまのフレーム 15 の値)
  });

  it('プロジェクトに保存して開くと、チャンネル・値・キーが戻る', async () => {
    const e = engineWithCube();
    const cube = e.world.objects[0];
    cube.mmeValues = { Si: 1, Tr: 0.5 };
    e.keyframes.insertMme(cube, 0, ['Si']);
    cube.mmeValues.Si = 3;
    e.keyframes.insertMme(cube, 30, ['Si']);
    const f = engineWithCube();
    await f.project.open(await e.project.save('reference'));
    const back = f.world.objects[0];
    expect(back.mmeChannels).toEqual(['Si']);
    expect(back.mmeValues).toEqual({ Si: 1, Tr: 0.5 }); // (開いたフレーム 0 の値)
    expect(back.anim!.mme).toEqual(cube.anim!.mme);
  });
});
