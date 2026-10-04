import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { addNode, connect, surfaceShader } from '../../core/materials/tree';
import { convertMmdMaterial, convertMmdMesh } from './fromMmd';
import { MaterialLibrary } from './MaterialLibrary';
import { toPmxValues } from './toPmx';
import { engineWithCube } from '../testEngine';

describe('MaterialLibrary', () => {
  it('Blender と同じく、同じ名前には .001 などを付ける', () => {
    const lib = new MaterialLibrary();
    expect([lib.create().name, lib.create().name, lib.create('マテリアル.001').name]).toEqual(['マテリアル', 'マテリアル.001', 'マテリアル.002']);
    const a = lib.create('髪');
    lib.rename(a.id, 'マテリアル');
    expect(a.name).toBe('マテリアル.003');
  });

  it('使う物ごとに材質を作り、値だけの変更ではシェーダーの形 (key) を変えずに uniform を入れ替える', () => {
    const lib = new MaterialLibrary();
    const mat = lib.create();
    const a = lib.instance(mat.id), b = lib.instance(mat.id);
    expect(a).not.toBe(b);
    expect(lib.users(mat.id)).toBe(2);
    const key = a.userData.nodeKey;
    const bsdf = surfaceShader(mat.tree)!;
    lib.edit(mat.id, d => { surfaceShader(d.tree)!.values.roughness = 0.9; });
    expect(a.userData.nodeKey).toBe(key);
    expect(a.userData.nodeUniforms[`u_${bsdf.id}_roughness`].value).toBe(0.9);
    expect(b.userData.nodeUniforms[`u_${bsdf.id}_roughness`].value).toBe(0.9);
    // つなぎ方を変えると形が変わる
    lib.edit(mat.id, d => {
      const v = addNode(d.tree, 'value');
      connect(d.tree, { node: v.id, socket: 'value' }, { node: bsdf.id, socket: 'metallic' });
    });
    expect(a.userData.nodeKey).not.toBe(key);
    expect(a.customProgramCacheKey()).toBe(a.userData.nodeKey);
  });

  it('設定と輪郭線を材質に反映する', () => {
    const lib = new MaterialLibrary();
    const mat = lib.create();
    const m = lib.instance(mat.id);
    lib.edit(mat.id, d => { d.settings.blend = 'blend'; d.settings.backfaceCulling = true; d.outline = { enabled: true, color: [1, 0, 0], size: 1.5 }; });
    expect([m.transparent, m.side]).toEqual([true, THREE.FrontSide]);
    expect(m.userData.outlineBase).toMatchObject({ visible: true, color: [1, 0, 0] });
    expect(m.userData.outlineBase.thickness).toBeCloseTo(0.005);
    lib.edit(mat.id, d => { d.settings.blend = 'clip'; });
    expect([m.transparent, m.alphaTest]).toEqual([false, 0.5]);
  });

  it('形のために自動で作ったマテリアルは、使う物がなくなったら消える。手を入れたものは残る', () => {
    const lib = new MaterialLibrary();
    const auto = lib.create('マテリアル', { auto: true });
    lib.release(lib.instance(auto.id));
    expect(lib.materials.has(auto.id)).toBe(false);
    const kept = lib.create('マテリアル', { auto: true });
    const m = lib.instance(kept.id);
    lib.edit(kept.id, () => {});
    lib.release(m);
    expect(lib.materials.has(kept.id)).toBe(true);
    expect(lib.list().find(x => x.id === kept.id)!.users).toBe(0);
  });
});

describe('物のマテリアルスロット (Engine)', () => {
  it('形にはその色のマテリアルが 1 つ入り、パレットの色はベースカラーを変える', () => {
    const e = engineWithCube();
    const cube = e.world.objects[0];
    e.select(cube);
    expect(e.materials.slots()).toMatchObject([{ index: 0, name: 'マテリアル' }]);
    e.setObjColor(3);
    expect(surfaceShader(e.materials.active()!.tree)!.values.baseColor).toEqual([0.18, 0.32, 0.85]);
  });

  it('新規・複製・外す・ほかのマテリアルを入れる (共有)', () => {
    const e = engineWithCube();
    e.addShape(0);
    const [a, b] = e.world.objects;
    e.select(a);
    const shared = e.materials.active()!;
    e.materials.rename('共有');
    e.select(b);
    e.materials.assign(shared.id);
    expect(e.library.users(shared.id)).toBe(2);
    expect((b.mesh!.material as THREE.Material).userData.materialId).toBe(shared.id);
    e.materials.duplicate();
    expect(e.materials.active()!.name).toBe('共有.001');
    expect(e.library.users(shared.id)).toBe(1);
    e.materials.assign(null);
    expect(e.materials.slots()[0].id).toBeNull();
    e.materials.create();
    expect(e.materials.active()!.name).toMatch(/^マテリアル/);
  });

  it('物を消すと材質を返し、選択中はオレンジの輪郭線を付ける', () => {
    const e = engineWithCube();
    const cube = e.world.objects[0];
    e.select(cube);
    e.materials.rename('残す'); // 手を入れたので、使う物がなくなっても残る
    const id = cube.slots[0]!;
    e.selection.syncOutlines(e.world.objects);
    expect((cube.mesh!.material as THREE.Material).userData.outlineParameters).toMatchObject({ visible: true, color: [1, 0.35, 0.02] });
    e.world.remove(cube);
    expect(e.library.users(id)).toBe(0);
    expect(e.library.materials.has(id)).toBe(true);
  });
});

describe('MMD の材質の変換と .pmx への書き戻し', () => {
  const toon = (opts: { map?: boolean; diffuse?: string; opacity?: number; transparent?: boolean } = {}) => {
    const m = new THREE.MeshPhongMaterial({ name: '髪', shininess: 50, specular: 0x808080, emissive: 0x333333, side: THREE.DoubleSide }) as THREE.MeshPhongMaterial & { diffuse: THREE.Color };
    const [r, g, b] = opts.diffuse === 'pink' ? [1, 0.5, 0.8] : [1, 1, 1];
    m.diffuse = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
    m.opacity = opts.opacity ?? 1;
    m.transparent = opts.transparent ?? false;
    if (opts.map) m.map = new THREE.Texture();
    m.userData.outlineParameters = { visible: true, thickness: 1 / 300, color: [0.1, 0.2, 0.3], alpha: 1 };
    return m;
  };

  it('テクスチャ × 色 (乗算) をベースカラーに、テクスチャのアルファ × 不透明度をアルファに', () => {
    const lib = new MaterialLibrary();
    const data = convertMmdMaterial(toon({ map: true, diffuse: 'pink', opacity: 0.5, transparent: true }), lib, 'x');
    const types = data.tree.nodes.map(n => n.type).sort();
    expect(types).toEqual(['image', 'math', 'mix', 'output', 'principled']);
    expect(data.settings).toEqual({ blend: 'blend', backfaceCulling: false });
    expect(data.outline).toMatchObject({ enabled: true, color: [0.1, 0.2, 0.3] });
    expect(data.outline.size).toBeCloseTo(1);
    const bsdf = surfaceShader(data.tree)!;
    expect(bsdf.values.roughness).toBeCloseTo(Math.sqrt(2 / 52));
    expect(lib.images.size).toBe(1);
  });

  it('見つからなかったテクスチャは使わず、色だけにする (読めない画像で黒く写らないように)', () => {
    const lib = new MaterialLibrary();
    const m = toon({ map: true, diffuse: 'pink' });
    m.userData.MMD = { mapFileName: 'tex\\Body.PNG' };
    const data = convertMmdMaterial(m, lib, 'x', new Set(['body.png']));
    expect(data.tree.nodes.map(n => n.type)).toEqual(['principled', 'output']);
    expect(surfaceShader(data.tree)!.values.baseColor).toEqual([1, new THREE.Color().setRGB(1, 0.5, 0.8, THREE.SRGBColorSpace).g, new THREE.Color().setRGB(1, 0.5, 0.8, THREE.SRGBColorSpace).b]);
    expect(lib.images.size).toBe(0);
    // ほかのテクスチャが見つからなくても、このテクスチャがあれば使う
    expect(convertMmdMaterial(m, lib, 'x', new Set(['face.png'])).tree.nodes.some(n => n.type === 'image')).toBe(true);
  });

  it('テクスチャも色もなければ、色をベースカラーに入れるだけ', () => {
    const lib = new MaterialLibrary();
    const data = convertMmdMaterial(toon(), lib, 'x');
    expect(data.tree.nodes.map(n => n.type)).toEqual(['principled', 'output']);
  });

  it('.pmx の値に戻すと、変えていなければ元の値、変えたところは新しい値になる', () => {
    const lib = new MaterialLibrary();
    const data = convertMmdMaterial(toon({ map: true, diffuse: 'pink' }), lib, 'x');
    const same = toPmxValues(data, data.mmd!);
    expect(same.diffuse.map(v => +v.toFixed(4))).toEqual(data.mmd!.diffuse.map(v => +v.toFixed(4)));
    expect(same.specularPower).toBeCloseTo(50, 3);
    expect(same.ambient.map(v => +v.toFixed(3))).toEqual(data.mmd!.ambient.map(v => +v.toFixed(3)));
    // 乗算の色を白に、粗さを 1 に、輪郭線を消す
    const mix = data.tree.nodes.find(n => n.type === 'mix')!;
    mix.values.b = [1, 1, 1];
    surfaceShader(data.tree)!.values.roughness = 1;
    data.outline.enabled = false;
    const changed = toPmxValues(data, data.mmd!);
    expect(changed.diffuse.slice(0, 3).map(v => +v.toFixed(4))).toEqual([1, 1, 1]);
    expect(changed.specularPower).toBeCloseTo(0);
    expect(changed.edge).toBe(false);
    // マテリアルがない (外した) スロットは元の値
    expect(toPmxValues(null, data.mmd!)).toEqual({ diffuse: data.mmd!.diffuse, specular: data.mmd!.specular, specularPower: 50,
      ambient: data.mmd!.ambient, edge: true, edgeColor: data.mmd!.edgeColor, edgeSize: data.mmd!.edgeSize });
  });

  it('convertMmdMesh は材質ごとのトゥーンとスフィアのテクスチャを残す (材質を捨てても破棄しない)', () => {
    const lib = new MaterialLibrary();
    const gradient = new THREE.Texture(), matcap = new THREE.Texture();
    let disposed = 0;
    gradient.addEventListener('dispose', () => disposed++);
    matcap.addEventListener('dispose', () => disposed++);
    const a = toon(), b = toon();
    Object.assign(a, { gradientMap: gradient, matcap });
    const mesh = { name: 'm', material: [a, b], userData: {} } as unknown as THREE.Mesh;
    convertMmdMesh(mesh, lib);
    expect(mesh.userData.mmeTextures).toEqual([{ toon: gradient, sphere: matcap }, { toon: null, sphere: null }]);
    expect(mesh.userData.mmeTextures[0].toon).toBe(gradient);
    expect(disposed).toBe(0);
  });
});
