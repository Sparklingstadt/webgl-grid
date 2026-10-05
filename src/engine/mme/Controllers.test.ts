import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { ControlRef } from '../../core/mme/controllers.ts';
import { toMmd } from '../../core/mme/coords.ts';
import { MODEL_KIND } from '../../core/shapes';
import type { Obj } from '../types';
import type { World } from '../world/World';
import { Controllers } from './Controllers';
import type { LoadedEffect } from './EffectStore';
import { compileEffect } from '../../core/fx/index.ts';

const ref = (name: string, item: string | null, type: ControlRef['type'] = 'float'): ControlRef => ({ param: 'p', name, item, type });

interface ModelOptions { morphs?: Record<string, number>; bones?: Record<string, [number, number, number]>; at?: [number, number, number]; hidden?: boolean }
// .pmx のファイル名・モーフ (名前 → 重み)・骨 (名前 → 位置。three.js の空間) を持つ MMD モデル
function model(id: number, file: string, { morphs = {}, bones = {}, at = [0, 0, 0], hidden }: ModelOptions = {}): Obj {
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry());
  mesh.userData.sourceFile = new File([], file);
  mesh.morphTargetDictionary = Object.fromEntries(Object.keys(morphs).map((n, i) => [n, i]));
  mesh.morphTargetInfluences = Object.values(morphs);
  const list = Object.entries(bones).map(([name, p]) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(...p);
    return b;
  });
  list.forEach(b => mesh.add(b));
  mesh.bind(new THREE.Skeleton(list));
  const node = new THREE.Group();
  node.add(mesh);
  node.position.set(...at);
  node.updateMatrixWorld(true);
  return { id, s: MODEL_KIND, model: mesh, node, hidden } as unknown as Obj;
}
const shape = (id: number, name: string): Obj => ({ id, s: 0, name, node: new THREE.Group() } as unknown as Obj);

function setup(objects: Obj[], stage: THREE.Object3D | null = null) {
  const warn = vi.fn();
  const c = new Controllers({ world: { objects } as unknown as World, stage: () => stage, warn });
  return { c, warn };
}

describe('Controllers: 仮のコントローラー', () => {
  it('set した値を返し、0〜1 に収める。なければ 0。名前の大文字小文字は問わない', () => {
    const { c } = setup([]);
    expect(c.value(ref('ray_controller.pmx', 'SSAO+'), null, null)).toEqual([0]);
    c.set('ray_controller.pmx', 'SSAO+', 0.5);
    expect(c.value(ref('ray_controller.pmx', 'SSAO+'), null, null)).toEqual([0.5]);
    expect(c.value(ref('Ray_Controller.pmx', 'SSAO+'), null, null)).toEqual([0.5]);
    c.set('ray_controller.pmx', 'SSAO+', 2);
    expect(c.value(ref('ray_controller.pmx', 'SSAO+'), null, null)).toEqual([1]);
    c.set('ray_controller.pmx', 'SSAO+', -3);
    expect(c.value(ref('ray_controller.pmx', 'SSAO+'), null, null)).toEqual([0]);
    expect(c.values.get('ray_controller.pmx')?.get('SSAO+')).toBe(0);
  });

  it('bool は 0 より大きければ 1。項目のないもの・float 以外は null (0)', () => {
    const { c } = setup([]);
    c.set('ctl.pmx', 'On', 0.2);
    expect(c.value(ref('ctl.pmx', 'On', 'bool'), null, null)).toEqual([1]);
    expect(c.value(ref('ctl.pmx', 'Off', 'bool'), null, null)).toEqual([0]);
    expect(c.value(ref('ctl.pmx', null), null, null)).toBeNull();
    expect(c.value(ref('ctl.pmx', 'On', 'float3'), null, null)).toBeNull();
    expect(c.value(ref('ctl.pmx', null, 'float4x4'), null, null)).toBeNull();
  });

  it('場面にその名前の物があれば、仮のコントローラーは使わない', () => {
    const { c } = setup([model(1, 'Ray_Controller.pmx', { morphs: { 'SSAO+': 0.25 } })]);
    c.set('ray_controller.pmx', 'SSAO+', 1);
    expect(c.value(ref('ray_controller.pmx', 'SSAO+'), null, null)).toEqual([0.25]);
  });
});

describe('Controllers: 場面の物', () => {
  it('(self) のモデルのモーフと骨の位置 (MMD の座標)。ないモーフ・骨は null', () => {
    const self = model(1, 'Light.pmx', { morphs: { 'R+': 0.75, 'G+': 0.5 }, bones: { Position: [1, 2, 3] }, at: [10, 0, 0] });
    const { c, warn } = setup([self]);
    expect(c.value(ref('(self)', 'R+'), self, null)).toEqual([0.75]);
    expect(c.value(ref('(SELF)', 'G+'), self, null)).toEqual([0.5]);
    expect(c.value(ref('(self)', 'Position', 'float3'), self, null)).toEqual([11, 2, -3]);
    expect(c.value(ref('(self)', 'Position', 'float4'), self, null)).toEqual([11, 2, -3]);
    expect(c.value(ref('(self)', 'B+'), self, null)).toBeNull();
    expect(c.value(ref('(self)', 'Nothing', 'float3'), self, null)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('(self) は描いている物。物がない (ステージ・ポストエフェクト) と null', () => {
    const a = model(1, 'A.pmx', { morphs: { M: 1 } }), b = model(2, 'B.pmx', { morphs: { M: 0.5 } });
    const { c } = setup([a, b]);
    expect(c.value(ref('(self)', 'M'), b, null)).toEqual([0.5]);
    expect(c.value(ref('(self)', 'M'), null, null)).toBeNull();
  });

  it('(OffscreenOwner) は持ち主 (self ではない)。持ち主がなければ null', () => {
    const owner = model(1, 'Owner.pmx', { morphs: { M: 0.5 } }), other = model(2, 'Other.pmx', { morphs: { M: 1 } });
    const { c } = setup([owner, other]);
    expect(c.value(ref('(OffscreenOwner)', 'M'), other, owner)).toEqual([0.5]);
    expect(c.value(ref('(offscreenowner)', 'M'), other, null)).toBeNull();
  });

  it('同じ名前の物が 2 つなら最初の物。名前は大文字小文字を問わず、MMD モデルは .pmx のファイル名、ほかは物の名前', () => {
    const { c } = setup([model(1, 'Twin.pmx', { morphs: { M: 0.25 } }), model(2, 'twin.pmx', { morphs: { M: 0.75 } })]);
    expect(c.value(ref('TWIN.pmx', 'M'), null, null)).toEqual([0.25]);
    const s = shape(3, 'Floor');
    s.node.position.set(1, 2, 3);
    s.node.updateMatrixWorld(true);
    expect(setup([s]).c.value(ref('floor', null, 'float3'), null, null)).toEqual([1, 2, -3]);
  });

  it('項目なし: float4x4 は MMD の座標のワールド行列、float3 は位置、bool は隠していなければ 1', () => {
    const m = model(1, 'M.pmx', { at: [1, 2, 3] });
    m.model.rotation.y = 0.5;
    m.node.updateMatrixWorld(true);
    const { c } = setup([m]);
    expect(c.value(ref('M.pmx', null, 'float4x4'), null, null)).toEqual(toMmd(m.model.matrixWorld).elements);
    expect(c.value(ref('M.pmx', null, 'float3'), null, null)).toEqual([1, 2, -3]);
    expect(c.value(ref('M.pmx', null, 'bool'), null, null)).toEqual([1]);
    expect(c.value(ref('M.pmx', null, 'float'), null, null)).toBeNull();
    m.hidden = true;
    expect(c.value(ref('M.pmx', null, 'bool'), null, null)).toEqual([0]);
    m.hidden = false;
    m.node.visible = false;
    expect(c.value(ref('M.pmx', null, 'bool'), null, null)).toEqual([0]);
  });

  it('骨の項目: float4x4 は骨のワールド行列 (MMD の座標)', () => {
    const m = model(1, 'M.pmx', { bones: { Bone: [1, 2, 3] }, at: [0, 5, 0] });
    const bone = m.model.skeleton.bones[0] as THREE.Bone;
    expect(setup([m]).c.value(ref('M.pmx', 'Bone', 'float4x4'), null, null)).toEqual(toMmd(bone.matrixWorld).elements);
  });

  it('アクセサリの項目 (Si ほか) は警告を 1 回出して null。モデルにその名前のモーフがあればそちら', () => {
    const self = model(1, 'M.pmx', { morphs: { Tr: 0.5 } });
    const { c, warn } = setup([self]);
    expect(c.value(ref('(self)', 'Si'), self, null)).toBeNull();
    expect(c.value(ref('(self)', 'Si'), self, null)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Si');
    for (const item of ['X', 'Y', 'Z', 'XYZ', 'Rx', 'Ry', 'Rz', 'Rxyz', 'Tr']) c.value(ref('(self)', item), self, null);
    expect(warn).toHaveBeenCalledTimes(9); // (Tr はモーフにあるので警告しない。Si は 1 回)
    expect(c.value(ref('(self)', 'Tr'), self, null)).toEqual([0.5]);
    c.clearWarnings();
    c.value(ref('(self)', 'Si'), self, null);
    expect(warn).toHaveBeenCalledTimes(10);
  });

  it('ステージの .pmx は、場面の物に合う名前がないときに名前で引ける', () => {
    const stageMesh = new THREE.SkinnedMesh(new THREE.BufferGeometry());
    stageMesh.userData.sourceFile = new File([], 'Stage.pmx');
    stageMesh.morphTargetDictionary = { M: 0 };
    stageMesh.morphTargetInfluences = [0.5];
    const stage = new THREE.Group();
    stage.add(stageMesh);
    const { c } = setup([], stage);
    expect(c.value(ref('stage.pmx', 'M'), null, null)).toEqual([0.5]);
    c.set('stage.pmx', 'M', 1);
    expect(c.value(ref('stage.pmx', 'M'), null, null)).toEqual([0.5]);
  });
});

describe('Controllers.catalog', () => {
  const effect = (decl: string): LoadedEffect => {
    const r = compileEffect('a.fx', p => (p === 'a.fx' ? new TextEncoder().encode(`${decl} float4 VS(float4 p : POSITION) : POSITION { return p; } float4 PS() : COLOR0 { return 1; } technique T { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }`) : null));
    return { id: 'e', name: 'a.fx', entry: 'a.fx', result: r } as unknown as LoadedEffect;
  };

  it('描いているエフェクトの項目から、場面にない名前のスライダーの元を作る', () => {
    const { c } = setup([model(1, 'Present.pmx')]);
    const e = effect(`
      float a : CONTROLOBJECT<string name = "ray_controller.pmx"; string item = "SSAO+";>;
      float b : CONTROLOBJECT<string name = "ray_controller.pmx"; string item = "Bloom+";>;
      float c : CONTROLOBJECT<string name = "present.pmx"; string item = "X";>;
      float d : CONTROLOBJECT<string name = "(self)"; string item = "R+";>;`);
    expect([...c.catalog([e])]).toEqual([['ray_controller.pmx', ['Bloom+', 'SSAO+']]]);
    expect(c.catalog([])).toEqual(new Map());
  });
});
