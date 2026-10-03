import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Engine } from './Engine';
import type { ModelObj } from './types';

// 描画先 (WebGL) なしでエンジンを組み立てて、操作の組み合わせを確かめる
describe('Engine (描画なし)', () => {
  it('最初は原点の立方体 1 個で、何も選んでいない', () => {
    const e = new Engine();
    expect(e.world.objects.map(o => [o.s, o.x, o.z])).toEqual([[0, 0, 0]]);
    expect(e.ui.state.sel).toBeNull();
    expect(e.ui.state.end).toBe(250);
  });

  it('形を追加すると、空いている場所に置いて選ぶ。32 個までしか置けない', () => {
    const e = new Engine();
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
    const e = new Engine();
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
    const e = new Engine();
    e.selectKeys([3, 5], false);
    expect([...e.keyframes.selected]).toEqual([3, 5]);
    e.addShape(0);
    expect(e.keyframes.selected.size).toBe(0);
  });

  it('最初の状態に戻すと、立方体 1 個・0 フレーム目・止まった状態になる', () => {
    const e = new Engine();
    e.addShape(2);
    e.clock.setRange(0, 99);
    e.clock.seekFrame(40);
    e.clock.setPlaying(true);
    e.resetAll();
    expect(e.world.objects.length).toBe(1);
    expect([e.clock.frame, e.clock.end, e.clock.playing]).toEqual([0, 250, false]);
    expect(e.ui.state).toMatchObject({ frame: 0, end: 250, playing: false, sel: null });
  });

  it('上から見る・視点を戻す', () => {
    const e = new Engine();
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
    const e = new Engine();
    const obj = fakeModel(e);
    obj.pose = new Map([[0, { rx: 0, ry: 0, rz: 0, px: 0, py: 0, pz: 0 }]]);
    e.insertKey();
    e.clock.seekFrame(300);
    obj.pose = new Map([[0, { rx: 0, ry: 0, rz: 90, px: 2, py: 0, pz: 0 }]]);
    obj.model.morphTargetInfluences = [1, 0];
    e.insertKey();
    expect([...obj.keys!.keys()]).toEqual([0, 300]);
    expect(e.clock.end).toBe(300);
    e.clock.seekFrame(150);
    expect(obj.pose.get(0)!.rz).toBeCloseTo(45);
    expect(obj.pose.get(0)!.px).toBeCloseTo(1);
    expect(obj.model.morphTargetInfluences[0]).toBeCloseTo(0.5);
    expect(e.timelineRows()[0]).toMatchObject({ label: 'テスト', keys: [0, 300], editable: true });
  });

  it('選んだキーフレームをずらす・消す。いまのフレームのキーを消す', () => {
    const e = new Engine();
    const obj = fakeModel(e);
    for (const f of [0, 10, 20]) { e.clock.seekFrame(f); e.insertKey(); }
    e.selectKeys([10], false);
    e.moveSelectedKeys(5);
    expect([...obj.keys!.keys()].sort((a, b) => a - b)).toEqual([0, 15, 20]);
    expect(e.deleteSelectedKeys()).toBe(true);
    expect([...obj.keys!.keys()].sort((a, b) => a - b)).toEqual([0, 20]);
    e.clock.seekFrame(20);
    e.deleteKeyHere();
    expect([...obj.keys!.keys()]).toEqual([0]);
  });

  it('↑↓ で前後のキーフレームへ飛ぶ', () => {
    const e = new Engine();
    fakeModel(e);
    for (const f of [5, 40]) { e.clock.seekFrame(f); e.insertKey(); }
    e.clock.seekFrame(0);
    e.jumpKey(1);
    expect(e.clock.frame).toBe(5);
    e.jumpKey(1);
    expect(e.clock.frame).toBe(40);
    e.jumpKey(-1);
    expect(e.clock.frame).toBe(5);
  });

  it('モデルを選んでいなければ打たずに知らせる', () => {
    const e = new Engine();
    e.insertKey();
    expect(e.ui.state.toast?.text).toContain('モデルをクリックして選んで');
  });
});
