import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { keyFrames } from '../../core/animation';
import { MAX_BOXES } from '../../core/constants';
import { normalizeMmeObj } from '../../core/mme/settings.ts';
import { Engine } from '../Engine';
import { objectName } from '../mme/Assignments';
import { engineWithCube } from '../testEngine';
import { kindOf, type Obj } from '../types';

// MME の物 (仮のコントローラー・仮のアクセサリ): 形のない物。アウトライナーではほかの物と同じに扱い、描かない・積まない
const step = (e: Engine) => e.history.checkpoint();
const fxRef = async (e: Engine, name = 'a.fx') => {
  const fx = await e.mme.loadEffect([new File(['technique T { }'], name)], name);
  return { folder: fx.folder.id, path: fx.entry };
};
// キー (Si: 0 フレームで 2、30 フレームで 3)・キーのない値 (X = 5)・.fx の割り当てを持つアクセサリ
const keyedAccessory = async (e: Engine) => {
  const obj = e.addMmeObject({ kind: 'accessory', name: 'a.x' });
  obj.mmeValues!.Si = 2;
  e.keyframes.insertMme(obj, 0, ['Si']);
  obj.mmeValues!.Si = 3;
  e.keyframes.insertMme(obj, 30, ['Si']);
  obj.mmeValues!.X = 5;
  e.mme.assign(obj, 'Main', null, await fxRef(e));
  e.clock.seekFrame(0);
  return obj;
};
const state = (o: Obj) => ({
  kind: kindOf(o), name: o.name, mmeObj: o.mmeObj, mmeValues: o.mmeValues, mmeChannels: o.mmeChannels, mme: o.mme, keys: keyFrames(o.anim),
});

describe('MME の物', () => {
  it('normalizeMmeObj: 種類と名前 (前後の空白を除き 64 文字まで) があるものだけ', () => {
    expect(normalizeMmeObj({ kind: 'accessory', name: ' ray.x ' })).toEqual({ kind: 'accessory', name: 'ray.x' });
    expect(normalizeMmeObj({ kind: 'controller', name: 'x'.repeat(80) })).toEqual({ kind: 'controller', name: 'x'.repeat(64) });
    for (const bad of [null, 'ray.x', { kind: 'model', name: 'a' }, { kind: 'accessory', name: '  ' }, { kind: 'accessory' }]) expect(normalizeMmeObj(bad)).toBeNull();
  });

  it('アクセサリを置くと、種類は mme・名前は data の名前・値は MMD の既定で、選ばれる。元に戻すと消え、やり直すと戻る', async () => {
    const e = engineWithCube();
    const obj = e.addMmeObject({ kind: 'accessory', name: 'a.x' });
    step(e);
    expect(e.world.objects).toEqual([expect.anything(), obj]);
    expect(kindOf(obj)).toBe('mme');
    expect([obj.name, obj.mmeObj]).toEqual(['a.x', { kind: 'accessory', name: 'a.x' }]);
    expect(obj.mmeValues).toEqual({ X: 0, Y: 0, Z: 0, Rx: 0, Ry: 0, Rz: 0, Si: 1, Tr: 1 });
    expect(e.ui.state.sel).toMatchObject({ id: obj.id, kind: 'mme', name: 'a.x' });
    expect(e.ui.state.history.labels).toEqual(['最初', '追加']);
    await e.history.undo();
    expect(e.world.objects.length).toBe(1);
    await e.history.redo();
    expect(e.world.objects[1]).toBe(obj);
    expect(obj.mmeValues!.Si).toBe(1);
  });

  it('置ける数を超えるときは、知らせて例外にする (何も置かない)', () => {
    const e = new Engine();
    for (let i = 0; i < MAX_BOXES; i++) e.world.addShape(0, i * 2, 0);
    expect(() => e.addMmeObject({ kind: 'accessory', name: 'a.x' })).toThrow('これ以上置けません');
    expect(e.ui.state.toast?.text).toBe('これ以上置けません');
    expect(e.world.objects.length).toBe(MAX_BOXES);
  });

  it('コントローラーは値を持たずに始まる (項目は描いているエフェクトから集める)', () => {
    const e = new Engine();
    const obj = e.addMmeObject({ kind: 'controller', name: 'ray_controller.pmx' });
    expect([kindOf(obj), obj.name, obj.mmeValues]).toEqual(['mme', 'ray_controller.pmx', undefined]);
  });

  it('名前を変えると mmeObj の名前も変わり、CONTROLOBJECT はその名前で照らす。空の名前にはできない', async () => {
    const e = new Engine();
    const obj = e.addMmeObject({ kind: 'controller', name: 'ray_controller.pmx' });
    step(e);
    e.renameObj(obj, 'ctrl.pmx');
    step(e);
    expect([obj.name, obj.mmeObj?.name, objectName(obj)]).toEqual(['ctrl.pmx', 'ctrl.pmx', 'ctrl.pmx']);
    e.renameObj(obj, '  ');
    expect([obj.name, obj.mmeObj?.name]).toEqual(['ctrl.pmx', 'ctrl.pmx']);
    await e.history.undo();
    expect([obj.name, obj.mmeObj?.name, objectName(obj)]).toEqual(['ray_controller.pmx', 'ray_controller.pmx', 'ray_controller.pmx']);
  });

  it('キーと .fx の割り当てを持つアクセサリを消して元に戻すと、キー・値・割り当てごと戻る', async () => {
    const e = engineWithCube();
    const obj = await keyedAccessory(e);
    step(e);
    const before = structuredClone(state(obj));
    expect(before).toMatchObject({ mmeChannels: ['Si'], keys: [0, 30], mmeValues: { Si: 2, X: 5 } });
    e.deleteSelected();
    step(e);
    expect(e.world.has(obj)).toBe(false);
    await e.history.undo();
    expect(e.world.objects[1]).toBe(obj);
    expect(state(obj)).toEqual(before);
    e.clock.seekFrame(30);
    expect(obj.mmeValues!.Si).toBe(3);
  });

  it('複製すると、値・キー・チャンネル・割り当てが写り (別の物として)、名前に番号が付く', async () => {
    const e = engineWithCube();
    const src = await keyedAccessory(e);
    step(e);
    const copy = (await e.duplicateSelected())!;
    expect(copy).not.toBe(src);
    expect(state(copy)).toEqual({ ...state(src), name: 'a.x.001', mmeObj: { kind: 'accessory', name: 'a.x.001' } });
    expect(objectName(copy)).toBe('a.x.001');
    // 写しを変えても元は変わらない
    copy.mmeValues!.X = 9;
    copy.anim!.mme.get(0)!.get(30)!.v = 7;
    expect([src.mmeValues!.X, src.anim!.mme.get(0)!.get(30)!.v]).toEqual([5, 3]);
    await e.history.undo();
    expect(e.world.objects.length).toBe(2);
  });

  it('.wgp に保存して開き直すと、同じ MME の物 (種類・名前・値・キー・割り当て) が戻る', async () => {
    const e = engineWithCube();
    const acc = await keyedAccessory(e);
    const ctrl = e.addMmeObject({ kind: 'controller', name: 'ray_controller.pmx' });
    ctrl.mmeValues = { 'SSAO+': 0.5 };
    e.renameObj(ctrl, 'ctrl.pmx');
    const bytes = await e.project.save('embedded');
    const f = engineWithCube();
    await f.project.open(bytes);
    const [, a, c] = f.world.objects;
    expect(f.world.objects.length).toBe(3);
    expect({ ...state(a), mme: undefined }).toEqual({ ...state(acc), mme: undefined });
    expect(a.mme?.Main.object).toMatchObject({ path: 'a.fx' });
    expect(state(c)).toEqual(state(ctrl));
    expect(c.mmeObj).toEqual({ kind: 'controller', name: 'ctrl.pmx' });
  });

  it('形がない: 描くものも目印もなく、ビューポートのクリックで選べない', () => {
    const e = new Engine();
    const obj = e.addMmeObject({ kind: 'accessory', name: 'a.x' });
    const drawn: THREE.Object3D[] = [];
    obj.node.traverse(o => { if ((o as THREE.Mesh).isMesh || (o as THREE.Line).isLine || (o as THREE.Light).isLight || (o as THREE.Points).isPoints) drawn.push(o); });
    expect(drawn).toEqual([]);
    expect(e.camera.pick({ ro: [obj.x, 0.5, obj.z + 5], rd: [0, 0, -1] })).toBeNull();
  });

  it('物を積む動きに入らない: 同じ所に形を置いても上に載らず、空いている場所も塞がない', () => {
    const e = new Engine();
    const obj = e.addMmeObject({ kind: 'accessory', name: 'a.x' });
    expect([obj.x, obj.z]).toEqual([0, 0]);
    e.addShape(0); // (画面中央 = 原点の近くの空いている場所)
    const cube = e.world.objects[1];
    expect([cube.x, cube.z, cube.y]).toEqual([0, 0, 0]);
    expect(e.placeShape(0, 0)).toBe(true); // (立方体の上に積む)
    const top = e.world.objects[2];
    expect(top.y).toBe(1);
    expect(e.world.stackFrom(obj)).toEqual([obj]);
    expect(e.world.stackFrom(cube)).toEqual([cube, top]);
    e.world.settle();
    expect([obj.y, obj.py, cube.y, top.y]).toEqual([0, 0, 0, 1]);
  });
});
