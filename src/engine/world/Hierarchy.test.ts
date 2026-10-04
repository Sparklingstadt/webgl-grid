import { describe, expect, it } from 'vitest';
import { engineWithCube } from '../testEngine';

describe('親子付け', () => {
  it('親が動く・回ると子も付いてくる。子を自分で動かしてもそのまま。輪にはできない。外すとその場に残る', () => {
    const e = engineWithCube();
    e.addShape(1);
    const [parent, child] = e.world.objects;
    Object.assign(child, { x: 2, z: 0 });
    e.select(child);
    e.selection.toggle(parent); // (アクティブ = 親)
    e.parentSelected();
    expect(child.parent).toBe(parent.id);
    // 親を動かす
    parent.x = 1;
    e.hierarchy.follow();
    expect([child.x, child.z]).toEqual([3, 0]);
    // 親を 90° 回す (上から見て反時計回り): 子は親のまわりを回る
    parent.r = Math.PI / 2;
    e.hierarchy.follow();
    expect(child.x).toBeCloseTo(1);
    expect(child.z).toBeCloseTo(-2);
    expect(child.r).toBeCloseTo(Math.PI / 2);
    // 子を自分で動かしても、そのまま付いてくる
    child.x += 1;
    parent.z = 5;
    e.hierarchy.follow();
    expect([child.x, child.z].map(v => +v.toFixed(5))).toEqual([2, 3]);
    // 輪にはできない
    expect(e.hierarchy.set(parent, child)).toBe(false);
    // 外す
    e.select(child);
    e.clearParent();
    parent.x = 10;
    e.hierarchy.follow();
    expect(child.parent).toBeUndefined();
    expect(child.x).toBeCloseTo(2);
  });
});

describe('コレクション', () => {
  it('選んでいる物をコレクションへ入れ、隠すと中の物は見えず選べない。名前を変える・消す。元に戻せる', async () => {
    const e = engineWithCube();
    e.addShape(1);
    const [a, b] = e.world.objects;
    e.select(a);
    const step = () => e.history.checkpoint();
    const name = e.newCollection();
    expect(name).toBe('コレクション');
    expect(e.newCollection()).toBe('コレクション.001');
    e.moveToCollection(name); step();
    expect(a.collection).toBe('コレクション');
    e.setCollectionHidden(name, true); step();
    expect([a.colHidden, a.node.visible, e.selection.current]).toEqual([true, false, null]);
    expect(e.camera.pick({ ro: [0, 0.5, 5], rd: [0, 0, -1] })?.obj ?? null).not.toBe(a);
    e.selectAll();
    expect(e.selection.list).toEqual([b]);
    e.renameCollection(name, '箱'); step();
    expect(a.collection).toBe('箱');
    e.removeCollection('箱'); step();
    expect([a.collection, a.colHidden, a.node.visible]).toEqual([undefined, undefined, true]);
    await e.history.undo();
    expect([a.collection, a.colHidden]).toEqual(['箱', true]);
  });
});
