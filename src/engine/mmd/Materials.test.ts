import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Engine } from '../Engine';
import type { ModelObj } from '../types';

// MMD の材質をまねた材質 (色を diffuse に持ち、輪郭線の設定を userData に持つ)
function toonLike(name: string, hex: string, edge: boolean) {
  const m = new THREE.MeshPhongMaterial({ name, emissive: 0x111111, specular: 0x222222, shininess: 5 }) as THREE.MeshPhongMaterial & { diffuse: THREE.Color };
  m.diffuse = new THREE.Color(hex);
  m.userData.outlineParameters = { visible: edge, thickness: edge ? 1 / 300 : 0, color: [0, 0, 0], alpha: 1 };
  return m;
}
function setup() {
  const e = new Engine();
  const model = new THREE.Mesh(new THREE.BoxGeometry(), [toonLike('髪', '#33ccdd', true), toonLike('肌', '#ffeedd', false)]);
  const obj = { id: 99, x: 0, y: 0, z: 0, c: -1, s: 3, r: 0, py: 0, vy: 0, h: 2, hx: 0.5, hz: 0.5,
                node: new THREE.Group(), model } as unknown as ModelObj;
  obj.node.add(model);
  e.world.objects.push(obj);
  e.select(obj);
  return { e, model, obj };
}

describe('材質 (マテリアル)', () => {
  it('材質の一覧と、色・輪郭線などの値を読む', () => {
    const { e } = setup();
    expect(e.materialList().map(m => m.name)).toEqual(['髪', '肌']);
    expect(e.material(0)).toMatchObject({ name: '髪', visible: true, diffuse: '#33ccdd', opacity: 1, ambient: '#111111', specular: '#222222', shininess: 5, edgeVisible: true });
    expect(e.material(0)!.edgeSize).toBeCloseTo(1);
    expect(e.material(1)!.edgeVisible).toBe(false);
  });

  it('色・不透明度・表示を変えると材質に反映され、透けるときだけ半透明にする', () => {
    const { e, model } = setup();
    const hair = (model.material as THREE.Material[])[0] as THREE.MeshPhongMaterial & { diffuse: THREE.Color };
    e.setMaterial(0, { diffuse: '#ff0000', opacity: 0.5 });
    expect(`#${hair.diffuse.getHexString()}`).toBe('#ff0000');
    expect([hair.opacity, hair.transparent]).toEqual([0.5, true]);
    e.setMaterial(0, { opacity: 1 });
    expect(hair.transparent).toBe(false);
    e.setMaterial(1, { visible: false });
    expect(e.materialList().map(m => [m.visible, m.edited])).toEqual([[true, true], [false, true]]);
  });

  it('元に戻すと、最初に変える前の値に戻る', () => {
    const { e } = setup();
    e.setMaterial(0, { diffuse: '#000000', shininess: 80, edgeVisible: false });
    e.setMaterial(0, { diffuse: '#123456' });
    e.resetMaterial(0);
    expect(e.material(0)).toMatchObject({ diffuse: '#33ccdd', shininess: 5, edgeVisible: true });
    expect(e.materialList()[0].edited).toBe(false);
    e.setMaterial(0, { opacity: 0.2 });
    e.setMaterial(1, { ambient: '#ffffff' });
    e.resetAllMaterials();
    expect(e.materialList().every(m => !m.edited)).toBe(true);
    expect(e.material(1)!.ambient).toBe('#111111');
  });

  it('選んでいるあいだのオレンジの輪郭線を崩さず、元の輪郭線の設定を変える', () => {
    const { e, model, obj } = setup();
    const hair = (model.material as THREE.Material[])[0];
    e.selection.syncOutlines([obj]); // 選択中のオレンジの輪郭線にする
    expect(hair.userData.outlineParameters.color).toEqual([1, 0.35, 0.02]);
    e.setMaterial(0, { edgeColor: '#ffffff', edgeSize: 2 });
    expect(e.material(0)).toMatchObject({ edgeColor: '#ffffff' });
    expect(e.material(0)!.edgeSize).toBeCloseTo(2);
    e.selection.syncOutlines([obj]); // 選択中は、新しい元の設定からオレンジの輪郭線を作り直す
    expect(hair.userData.outlineParameters.color).toEqual([1, 0.35, 0.02]);
    e.select(null);
    e.selection.syncOutlines([obj]); // 選択を外すと、変えた輪郭線になる
    expect(hair.userData.outlineParameters.color).toEqual([1, 1, 1]);
    expect(hair.userData.outlineParameters.thickness).toBeCloseTo(2 / 300);
  });

  it('モデルを選んでいなければ何もしない', () => {
    const e = new Engine();
    expect(e.materialList()).toEqual([]);
    expect(e.material(0)).toBeNull();
    expect(() => e.setMaterial(0, { opacity: 0 })).not.toThrow();
  });
});
