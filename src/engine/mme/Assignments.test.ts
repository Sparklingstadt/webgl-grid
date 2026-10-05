import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { parseDefaultEffect } from '../../core/mme/defaultEffect.ts';
import { normalizeObjectEffects, type ObjectEffects } from '../../core/mme/settings.ts';
import { MODEL_KIND } from '../../core/shapes';
import type { Obj } from '../types';
import type { UiChannel } from '../UiChannel';
import { Assignments, objectName } from './Assignments';
import { EffectStore, type LoadedEffect } from './EffectStore';
import { registerMmdSource } from './mmdData';
import type { Slot } from './ScenePass';

// フォルダから選んだファイル (webkitRelativePath は 'フォルダ/…')
function fileAt(path: string, text: string): File {
  const f = new File([text], path.slice(path.lastIndexOf('/') + 1));
  Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
}

const store = () => new EffectStore({ toast: vi.fn() } as unknown as UiChannel);
const mesh = new THREE.Mesh();
const shape = (id: number, mme?: ObjectEffects, name?: string) => ({ id, s: 0, name, mme } as unknown as Obj);
// .pmx のファイル名を持つ MMD モデル (sourceFile)
const model = (id: number, file: string, mme?: ObjectEffects) => ({
  id, s: MODEL_KIND, mme, model: { name: 'モデルの中の名前', geometry: new THREE.BufferGeometry(), userData: { sourceFile: new File([], file) } },
} as unknown as Obj);
const effectOf = (slot: Slot): LoadedEffect | 'hide' => (slot.kind === 'hide' ? 'hide' : slot.effect);

describe('normalizeObjectEffects', () => {
  it('壊れた値 (数・知らない形・材質の番号でないキー) を捨て、何も残らなければ null', () => {
    for (const raw of [undefined, null, 3, 'hide', [], {}, { Main: 3 }, { Main: {} }, { Main: { object: 'show' } }]) expect(normalizeObjectEffects(raw)).toBeNull();
    const ref = { folder: 'folder1', path: 'a.fx' };
    expect(normalizeObjectEffects({
      Main: { object: ref, materials: { 0: 'hide', 1: { folder: 'folder1', path: 'b.fx', extra: 1 }, x: 'hide', '-1': 'hide', '01': 'hide', 2: 5, 3: { folder: '', path: 'a.fx' } } },
      MaterialMap: { object: { folder: 3, path: 'a.fx' }, materials: [] },
      '': { object: ref },
      Shadow: { object: 'hide' },
    })).toEqual({
      Main: { object: ref, materials: { 0: 'hide', 1: { folder: 'folder1', path: 'b.fx' } } },
      Shadow: { object: 'hide' },
    });
  });
});

describe('objectName', () => {
  it('MMD モデルは .pmx のファイル名 (形に登録した .pmx が先)、ほかは付けた名前か種類の名前', () => {
    const m = model(1, 'Miku.pmx');
    expect(objectName(m)).toBe('Miku.pmx');
    registerMmdSource((m.model as THREE.Mesh).geometry, new File([], 'Original.pmx'));
    expect(objectName(m)).toBe('Original.pmx');
    expect(objectName(shape(2, undefined, 'Floor'))).toBe('Floor');
    expect(objectName(shape(3))).toBe('立方体');
  });
});

describe('Assignments', () => {
  it('材質の割り当て → 物の割り当て → default.fx。モデルの材質の数より大きい番号の割り当ては使われない', async () => {
    const s = store();
    const folder = await s.addFolder([fileAt('fx/a.fx', 'technique T { }')]);
    const a = s.effect(folder, 'a.fx');
    const ref = { folder: folder.id, path: 'a.fx' };
    const obj = shape(1, { Main: { object: ref, materials: { 1: 'hide', 7: 'hide' } } });
    const plain = shape(2);
    const slotFor = new Assignments(s, vi.fn()).slotFor('Main', null, null);
    expect([0, 1].map(i => effectOf(slotFor(obj, mesh, i)))).toEqual([a, 'hide']);
    expect(effectOf(slotFor(plain, mesh, 0))).toBe(s.defaultEffect);
    expect(effectOf(slotFor(null, mesh, 0))).toBe(s.defaultEffect); // (ステージ)
    // 材質だけに当てる (物の割り当てなし)
    obj.mme = { Main: { materials: { 1: ref } } };
    expect([0, 1].map(i => effectOf(slotFor(obj, mesh, i)))).toEqual([s.defaultEffect, a]);
    // 割り当ては毎回 Obj.mme から読む (変えたらすぐ効く)
    obj.mme = undefined;
    expect(effectOf(slotFor(obj, mesh, 1))).toBe(s.defaultEffect);
  });

  it('DefaultEffect の規則で名前から決める (self は持ち主だけ・none は default.fx・どれにも合わなければ hide)。パスはエントリーのフォルダから大文字小文字を無視して探す', async () => {
    const s = store();
    const folder = await s.addFolder([fileAt('Ray/ray.fx', 'technique T { }'), fileAt('Ray/Materials/Material_2.0.fx', 'technique T { }'), fileAt('Ray/sub/x.fx', '')]);
    const { rules } = parseDefaultEffect('self = hide; ray_controller.pmx = hide; floor = none; *.pmx = ../materials/material_2.0.fx; cube* = ./materials/material_2.0.fx;');
    const owner = model(1, 'owner.pmx');
    const slotFor = new Assignments(s, vi.fn()).slotFor('MaterialMap', { rules, base: 'sub', folder }, owner);
    const material = s.effect(folder, 'Materials/Material_2.0.fx');
    expect(effectOf(slotFor(model(2, 'RAY_CONTROLLER.pmx'), mesh, 0))).toBe('hide');
    expect(effectOf(slotFor(model(3, 'Miku.pmx'), mesh, 0))).toBe(material);
    expect(effectOf(slotFor(owner, mesh, 0))).toBe('hide'); // self
    expect(effectOf(slotFor(shape(4, undefined, 'Floor'), mesh, 0))).toBe(s.defaultEffect); // none
    expect(effectOf(slotFor(shape(5, undefined, 'Sphere'), mesh, 0))).toBe('hide'); // どれにも合わない
    // 物・材質の割り当ては規則より先
    const ref = { folder: folder.id, path: 'ray.fx' };
    const assigned = model(6, 'ray_controller.pmx', { MaterialMap: { materials: { 0: ref } } });
    expect([0, 1].map(i => effectOf(slotFor(assigned, mesh, i)))).toEqual([s.effect(folder, 'ray.fx'), 'hide']);
  });

  it('割り当てたフォルダ・ファイルがなければ、警告を 1 回出して既定で描く', async () => {
    const s = store();
    const folder = await s.addFolder([fileAt('fx/a.fx', 'technique T { }')]);
    const warn = vi.fn();
    const slotFor = new Assignments(s, warn).slotFor('Main', null, null);
    const lost = shape(1, { Main: { object: { folder: 'folder99', path: 'a.fx' } } });
    const missing = shape(2, { Main: { object: { folder: folder.id, path: 'b.fx' } } });
    for (let k = 0; k < 2; k++) {
      expect(effectOf(slotFor(lost, mesh, 0))).toBe(s.defaultEffect);
      expect(effectOf(slotFor(missing, mesh, 0))).toBe(s.defaultEffect);
    }
    expect(warn).toHaveBeenCalledTimes(2);
    // 材質の割り当てがなくなっていれば、物の割り当てに戻る
    const fallback = shape(3, { Main: { object: { folder: folder.id, path: 'A.FX' }, materials: { 0: { folder: folder.id, path: 'gone.fx' } } } });
    expect(effectOf(slotFor(fallback, mesh, 0))).toBe(s.effect(folder, 'a.fx'));
  });

  it('オフスクリーンのタブ (DefaultEffect がある) では、見つからない .fx・コンパイルできない .fx は描かない (hide。警告はそれぞれ 1 回)', async () => {
    const s = store();
    const folder = await s.addFolder([fileAt('fx/a.fx', 'technique T { }'), fileAt('fx/broken.fx', 'technique T { pass P { VertexShader = compile vs_3_0 nothing(); } }')]);
    const warn = vi.fn();
    const { rules } = parseDefaultEffect('gone* = gone.fx; bad* = broken.fx; * = a.fx;');
    const slotFor = new Assignments(s, warn).slotFor('MaterialMap', { rules, base: '', folder }, null);
    const missing = shape(1, { MaterialMap: { materials: { 0: { folder: folder.id, path: 'nothing.fx' } }, object: { folder: folder.id, path: 'a.fx' } } });
    for (let k = 0; k < 2; k++) {
      expect(effectOf(slotFor(shape(2, undefined, 'gone1'), mesh, 0))).toBe('hide');
      expect(effectOf(slotFor(shape(3, undefined, 'bad1'), mesh, 0))).toBe('hide');
      expect(effectOf(slotFor(missing, mesh, 0))).toBe('hide'); // (物の割り当てに戻らない)
      expect(effectOf(slotFor(missing, mesh, 1))).toBe(s.effect(folder, 'a.fx'));
    }
    expect(warn.mock.calls.map(c => c[0])).toEqual([
      'fx/gone.fx が見つからないので、オフスクリーン MaterialMap では描きません',
      'fx/broken.fx をコンパイルできないので、オフスクリーン MaterialMap では描きません',
      'fx/nothing.fx が見つからないので、オフスクリーン MaterialMap では描きません',
    ]);
  });

  it('referenced: 物の全部のタブで割り当てていて、探せる .fx', async () => {
    const s = store();
    const folder = await s.addFolder([fileAt('fx/a.fx', 'technique T { }'), fileAt('fx/b.fx', 'technique T { }')]);
    const warn = vi.fn();
    const obj = shape(1, { Main: { object: { folder: folder.id, path: 'a.fx' }, materials: { 2: 'hide', 3: { folder: 'nowhere', path: 'a.fx' } } }, Shadow: { materials: { 0: { folder: folder.id, path: 'b.fx' } } } });
    expect(new Assignments(s, warn).referenced(obj)).toEqual([s.effect(folder, 'a.fx'), s.effect(folder, 'b.fx')]);
    expect(warn).not.toHaveBeenCalled(); // (描くときに警告する)
  });
});
