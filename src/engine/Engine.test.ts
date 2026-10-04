import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { keyFrames } from '../core/animation';
import { Engine } from './Engine';
import type { ModelObj } from './types';
import { engineWithCube } from './testEngine';

// 描画先 (WebGL) なしでエンジンを組み立てて、操作の組み合わせを確かめる
describe('Engine (描画なし)', () => {
  it('最初は何も置いておらず、何も選んでいない。元に戻す履歴もない', () => {
    const e = new Engine();
    expect(e.world.objects).toEqual([]);
    expect(e.ui.state.sel).toBeNull();
    expect(e.history.canUndo).toBe(false);
    expect(e.ui.state.end).toBe(250);
  });

  it('形を追加すると、空いている場所に置いて選ぶ。32 個までしか置けない', () => {
    const e = engineWithCube();
    e.addShape(1);
    const torus = e.world.objects[1];
    expect(torus.s).toBe(1);
    expect(torus.x !== 0 || torus.z !== 0).toBe(true);
    expect(e.ui.state.sel).toMatchObject({ kind: 'shape', name: 'トーラス' });
    for (let i = 0; i < 40; i++) e.addShape(0);
    expect(e.world.objects.length).toBe(32);
    expect(e.ui.state.canAdd).toBe(false);
  });

  it('重なる場所に動かすと上に積まれ、下の物を消すと落ちる', () => {
    const e = engineWithCube();
    e.addShape(0);
    const [a, b] = e.world.objects;
    e.select(b);
    e.setObjProp('x', a.x);
    e.setObjProp('z', a.z);
    expect(b.y).toBe(1);
    e.select(a);
    e.deleteSelected();
    expect(b.y).toBe(0);
    expect(e.selection.current).toBeNull();
  });

  it('選択を変えると、選んでいたキーフレームの選択は外れる', () => {
    const e = engineWithCube();
    e.selectKeys([3, 5], false);
    expect([...e.keyframes.selected]).toEqual([3, 5]);
    e.addShape(0);
    expect(e.keyframes.selected.size).toBe(0);
  });

  it('最初の状態に戻すと、何もない場面・0 フレーム目・止まった状態になる', () => {
    const e = engineWithCube();
    e.addShape(2);
    e.clock.setRange(0, 99);
    e.clock.seekFrame(40);
    e.clock.setPlaying(true);
    e.resetAll();
    expect(e.world.objects.length).toBe(0);
    expect([e.clock.frame, e.clock.end, e.clock.playing]).toEqual([0, 250, false]);
    expect(e.ui.state).toMatchObject({ frame: 0, end: 250, playing: false, sel: null });
  });

  it('複数選択: Shift で足す・外す、すべて・反転。消す・隠す・複製は選んでいる物すべて', async () => {
    const e = engineWithCube();
    e.addShape(1); e.addShape(2);
    const [a, b, c] = e.world.objects;
    e.select(a);
    e.selection.toggle(b);
    expect([e.selection.list, e.selection.current, e.ui.state.selIds]).toEqual([[a, b], b, [a.id, b.id]]);
    e.selection.toggle(a); // 選んでいてアクティブでない → アクティブに
    expect([e.selection.list, e.selection.current]).toEqual([[a, b], a]);
    e.selection.toggle(a); // アクティブ → 外す
    expect([e.selection.list, e.selection.current]).toEqual([[b], null]);
    e.invertSelection();
    expect(e.selection.list).toEqual([a, c]);
    e.selectAll();
    expect(e.selection.list).toEqual([a, b, c]);
    // 複製: 全部を複製して、新しい方を選ぶ
    const copy = await e.duplicateSelected();
    expect(e.world.objects.length).toBe(6);
    expect(e.selection.list.length).toBe(3);
    expect(e.selection.list).not.toContain(a);
    expect(e.selection.current).toBe(copy);
    // 隠すと選択から外れる。消すと選んでいる物すべてが消える
    e.setVisibility(copy!, { hidden: true });
    expect(e.selection.list.length).toBe(2);
    e.deleteSelected();
    expect(e.world.objects.length).toBe(4);
    expect(e.selection.list).toEqual([]);
  });

  it('カメラ: いまの視点に置き、テンキー 0 でそこから見る。レンダリングのあいだは場面のカメラ。キーも打てる', () => {
    const e = engineWithCube();
    e.camera.update();
    const pos = e.camera.camera.position.clone();
    const cam = e.addCamera()!;
    expect([cam.x, cam.z, cam.camera!.height]).toEqual([pos.x, pos.z, pos.y].map(v => expect.closeTo(v, 5)));
    expect(e.ui.state.sel).toMatchObject({ kind: 'camera', name: 'カメラ' });
    expect(e.world.objects[0].y).toBe(0); // (カメラは積み重ねに加わらない)
    // テンキー 0: カメラから見ると、視点がカメラの位置になる
    e.toggleCameraView();
    expect(e.viewingCamera).toBe(true);
    e.camera.update();
    expect(e.camera.camera.position.distanceTo(new THREE.Vector3(cam.x, cam.py, cam.z))).toBeLessThan(1e-6);
    e.toggleCameraView();
    expect(e.viewingCamera).toBe(false);
    // レンダリングのあいだだけ、場面のカメラ
    e.output.hooks.begin!();
    expect(e.camera.override).not.toBeNull();
    e.output.hooks.end!();
    expect(e.camera.override).toBeNull();
    // 設定・キー (位置・回転・視野角・高さ。大きさはない)
    e.setCamera({ fov: 60, tiltDeg: 20 });
    expect(cam.camera).toMatchObject({ fov: 60, tiltDeg: 20 });
    e.insertKey();
    expect([...cam.anim!.props.keys()]).toEqual([0, 1, 2, 8, 9]);
  });

  it('上から見る・視点を戻す', () => {
    const e = engineWithCube();
    e.camera.snapView('top');
    expect(e.camera.viewName).toBe('上');
    expect(e.camera.cam.pitch).toBeCloseTo(1.5);
    e.camera.resetView();
    expect(e.camera.viewName).toBe('');
  });
});

// キーフレームは、モーションのあるモデル (IK の計算をしない) の形をまねた物で確かめる
function fakeModel(e: Engine): ModelObj {
  const model = Object.assign(new THREE.Object3D(), { morphTargetInfluences: [0, 0], name: 'テスト' });
  const obj = { id: 99, x: 0, y: 0, z: 0, c: -1, s: 3, r: 0, py: 0, vy: 0, h: 2, hx: 0.5, hz: 0.5,
                node: new THREE.Group(), model, animated: true } as ModelObj;
  e.world.objects.push(obj);
  e.selection.select(obj);
  return obj;
}

describe('キーフレーム', () => {
  it('2 つ打つと、あいだのフレームでは補間した姿勢と表情になり、終了フレームも延びる', () => {
    const e = engineWithCube();
    const obj = fakeModel(e);
    obj.pose = new Map([[0, { rx: 0, ry: 0, rz: 0, px: 0, py: 0, pz: 0 }]]);
    e.insertKey();
    e.clock.seekFrame(300);
    obj.pose = new Map([[0, { rx: 0, ry: 0, rz: 90, px: 2, py: 0, pz: 0 }]]);
    obj.model.morphTargetInfluences = [1, 0];
    e.insertKey();
    expect(keyFrames(obj.anim)).toEqual([0, 300]);
    expect(e.clock.end).toBe(300);
    e.clock.seekFrame(150);
    expect(obj.pose.get(0)!.rz).toBeCloseTo(45);
    expect(obj.pose.get(0)!.px).toBeCloseTo(1);
    expect(obj.model.morphTargetInfluences[0]).toBeCloseTo(0.5);
    expect(e.timelineRows()[0]).toMatchObject({ label: 'テスト', keys: [0, 300], editable: true });
  });

  it('選んだキーフレームをずらす・消す。いまのフレームのキーを消す', () => {
    const e = engineWithCube();
    const obj = fakeModel(e);
    obj.pose = new Map([[0, { rx: 0, ry: 0, rz: 0, px: 0, py: 0, pz: 0 }]]);
    for (const f of [0, 10, 20]) { e.clock.seekFrame(f); e.insertKey(); }
    e.selectKeys([10], false);
    e.moveSelectedKeys(5);
    expect(keyFrames(obj.anim)).toEqual([0, 15, 20]);
    expect(e.deleteSelectedKeys()).toBe(true);
    expect(keyFrames(obj.anim)).toEqual([0, 20]);
    e.clock.seekFrame(20);
    e.deleteKeyHere();
    expect(keyFrames(obj.anim)).toEqual([0]);
  });

  it('↑↓ で前後のキーフレームへ飛ぶ', () => {
    const e = engineWithCube();
    fakeModel(e).pose = new Map([[0, { rx: 0, ry: 0, rz: 0, px: 0, py: 0, pz: 0 }]]);
    for (const f of [5, 40]) { e.clock.seekFrame(f); e.insertKey(); }
    e.clock.seekFrame(0);
    e.jumpKey(1);
    expect(e.clock.frame).toBe(5);
    e.jumpKey(1);
    expect(e.clock.frame).toBe(40);
    e.jumpKey(-1);
    expect(e.clock.frame).toBe(5);
  });

  it('何も選んでいなければ打たずに知らせる', () => {
    const e = engineWithCube();
    e.insertKey();
    expect(e.ui.state.toast?.text).toContain('物をクリックして選んで');
    expect(e.world.objects[0].anim ?? null).toBeNull();
  });

  it('形・ライトは位置・回転・大きさにキーを打ち、あいだは補間する。元に戻す・プロジェクトにも残り、再生しただけでは手にならない', async () => {
    const e = engineWithCube();
    const cube = e.world.objects[0];
    e.select(cube);
    e.clock.seekFrame(0);
    e.insertKey();
    e.clock.seekFrame(20);
    e.setObjProp('x', 4);
    e.setObjProp('r', 90);
    e.setScale(cube, 3);
    e.insertKey();
    expect(keyFrames(cube.anim)).toEqual([0, 20]);
    expect([...cube.anim!.props.keys()]).toEqual([0, 1, 2, 3]);
    e.clock.seekFrame(10);
    expect(cube.x).toBeCloseTo(2);
    expect(cube.r).toBeCloseTo(Math.PI / 4);
    expect(cube.scale).toBeCloseTo(2);
    expect(e.timelineRows()[0]).toMatchObject({ label: '立方体', keys: [0, 20], editable: true });
    // 再生で動いても、元に戻すの手は増えない
    e.history.checkpoint();
    const steps = e.ui.state.history.labels.length;
    e.clock.seekFrame(15);
    e.history.checkpoint();
    expect(e.ui.state.history.labels.length).toBe(steps);
    // キーを消すと、その場に止まる
    e.deleteKeyHere();
    expect(keyFrames(cube.anim)).toEqual([0, 20]); // (15 にはキーがない)
    e.clock.seekFrame(20);
    e.deleteKeyHere();
    expect(keyFrames(cube.anim)).toEqual([0]);
  });

  it('ライトの強さ・色・高さ、カメラの視野角にもキーを打ち、あいだは補間する。再生しただけでは手にならず、元に戻せる', () => {
    const e = engineWithCube();
    const light = e.addLight('point')!, cam = e.addCamera({ fov: 30 })!;
    for (const [f, power, color, height, fov] of [[0, 100, '#000000', 2, 30], [20, 300, '#ff8000', 6, 70]] as const) {
      e.clock.seekFrame(f);
      e.select(light); e.setLight({ power, color, height }); e.insertKey();
      e.select(cam); e.setCamera({ fov }); e.insertKey();
    }
    expect([...light.anim!.props.keys()]).toEqual([0, 1, 2, 4, 5, 6, 7, 9]);
    e.clock.seekFrame(10);
    expect(light.light!.power).toBeCloseTo(200);
    expect(light.light!.height).toBeCloseTo(4);
    expect(light.light!.color).toMatch(/^#(7f|80)4000$/); // (色は半分のところ)
    expect(light.py).toBeCloseTo(4);
    expect(cam.camera!.fov).toBeCloseTo(50);
    e.history.checkpoint();
    const steps = e.ui.state.history.labels.length;
    e.clock.seekFrame(15);
    e.history.checkpoint();
    expect(e.ui.state.history.labels.length).toBe(steps);
    expect(light.light!.power).toBeCloseTo(250);
  });
});
