import { describe, expect, it } from 'vitest';
import { hexToLinear, linearToHex } from './color';
import { generate } from './glsl';
import { addNode, cloneTree, connect, createTree, disconnect, inputLink, removeNode, surfaceShader, upstreamOrder, whyNotConnect } from './tree';

describe('ノードツリー', () => {
  it('新しいマテリアルは、プリンシプル BSDF がマテリアル出力のサーフェスにつながっている', () => {
    const t = createTree();
    expect(t.nodes.map(n => n.type)).toEqual(['principled', 'output']);
    const bsdf = surfaceShader(t)!;
    expect(bsdf.type).toBe('principled');
    expect(bsdf.values.baseColor).toEqual([0.8, 0.8, 0.8]);
    expect(bsdf.values.roughness).toBe(0.5);
  });

  it('つなぐと、その入力の前のリンクは置き換わる', () => {
    const t = createTree();
    const bsdf = surfaceShader(t)!;
    const a = addNode(t, 'rgb'), b = addNode(t, 'rgb');
    expect(connect(t, { node: a.id, socket: 'color' }, { node: bsdf.id, socket: 'baseColor' })).toBe(true);
    expect(connect(t, { node: b.id, socket: 'color' }, { node: bsdf.id, socket: 'baseColor' })).toBe(true);
    expect(inputLink(t, bsdf.id, 'baseColor')!.from.node).toBe(b.id);
    expect(t.links.filter(l => l.to.socket === 'baseColor')).toHaveLength(1);
    expect(disconnect(t, { node: bsdf.id, socket: 'baseColor' })).toBe(true);
    expect(inputLink(t, bsdf.id, 'baseColor')).toBeNull();
  });

  it('つなげないもの: シェーダーと色、輪になるつなぎ方、つなげない入力、同じノード', () => {
    const t = createTree();
    const bsdf = surfaceShader(t)!;
    const m1 = addNode(t, 'mix'), m2 = addNode(t, 'mix');
    expect(whyNotConnect(t, { node: bsdf.id, socket: 'bsdf' }, { node: m1.id, socket: 'a' })).toContain('シェーダー');
    expect(connect(t, { node: m1.id, socket: 'result' }, { node: m2.id, socket: 'a' })).toBe(true);
    expect(whyNotConnect(t, { node: m2.id, socket: 'result' }, { node: m1.id, socket: 'b' })).toContain('輪');
    expect(whyNotConnect(t, { node: m1.id, socket: 'result' }, { node: m1.id, socket: 'b' })).toContain('同じノード');
    const v = addNode(t, 'value');
    expect(whyNotConnect(t, { node: v.id, socket: 'value' }, { node: bsdf.id, socket: 'ior' })).toContain('つなげません');
    // 色を値の入力につなぐのはよい (変換する)
    expect(whyNotConnect(t, { node: m1.id, socket: 'result' }, { node: bsdf.id, socket: 'roughness' })).toBeNull();
  });

  it('ノードを消すと、そのリンクも消える。マテリアル出力は消せない', () => {
    const t = createTree();
    const bsdf = surfaceShader(t)!;
    const out = t.nodes.find(n => n.type === 'output')!;
    expect(removeNode(t, out.id)).toBe(false);
    expect(removeNode(t, bsdf.id)).toBe(true);
    expect(t.links).toEqual([]);
    expect(surfaceShader(t)).toBeNull();
  });

  it('入力側から順に並べる。複製は元と別物', () => {
    const t = createTree();
    const bsdf = surfaceShader(t)!;
    const img = addNode(t, 'image'), mix = addNode(t, 'mix');
    connect(t, { node: img.id, socket: 'color' }, { node: mix.id, socket: 'a' });
    connect(t, { node: mix.id, socket: 'result' }, { node: bsdf.id, socket: 'baseColor' });
    expect(upstreamOrder(t, bsdf.id).map(n => n.type)).toEqual(['image', 'mix', 'principled']);
    const c = cloneTree(t);
    c.nodes[0].x = 999;
    expect(t.nodes[0].x).not.toBe(999);
  });
});

describe('GLSL の組み立て', () => {
  it('つながっていない入力は uniform にする', () => {
    const t = createTree();
    const bsdf = surfaceShader(t)!;
    const code = generate(t, () => false);
    expect(code.base).toBe(`u_${bsdf.id}_baseColor`);
    expect(code.decls).toContain(`uniform vec3 u_${bsdf.id}_baseColor;`);
    expect(code.decls).toContain(`uniform float u_${bsdf.id}_roughness;`);
    expect(code.constants).toEqual({ ior: 1.5, specular: 0.5, transmission: 0, coat: 0, coatRoughness: 0.03, sheen: 0 });
  });

  it('画像 × 色 (乗算) をベースカラーに、画像のアルファをアルファにつなぐ', () => {
    const t = createTree();
    const bsdf = surfaceShader(t)!;
    const img = addNode(t, 'image'), mix = addNode(t, 'mix');
    img.props.image = 'img1';
    mix.props.blend = 'multiply';
    connect(t, { node: img.id, socket: 'color' }, { node: mix.id, socket: 'a' });
    connect(t, { node: mix.id, socket: 'result' }, { node: bsdf.id, socket: 'baseColor' });
    connect(t, { node: img.id, socket: 'alpha' }, { node: bsdf.id, socket: 'alpha' });
    const code = generate(t, id => id === 'img1');
    expect(code.body).toContain(`texture2D(u_${img.id}_image, vUv)`);
    expect(code.body).toContain(`* b_${mix.id}`);
    expect(code.base).toBe(`v_${mix.id}_result`);
    expect(code.alpha).toContain(`v_${img.id}_alpha`);
    expect(code.uniforms.find(u => u.kind === 'sampler')).toMatchObject({ node: img.id, socket: 'image' });
    // 画像がなければ赤紫になり、形 (key) も変わる
    const missing = generate(t, () => false);
    expect(missing.body).toContain('vec4(1.0, 0.0, 1.0, 1.0)');
    expect(missing.key).not.toBe(code.key);
  });

  it('値だけ変えても形 (key) は変わらず、つなぎ方を変えると変わる', () => {
    const t = createTree();
    const bsdf = surfaceShader(t)!;
    const k1 = generate(t, () => false).key;
    bsdf.values.roughness = 0.9;
    expect(generate(t, () => false).key).toBe(k1);
    const v = addNode(t, 'value');
    connect(t, { node: v.id, socket: 'value' }, { node: bsdf.id, socket: 'roughness' });
    expect(generate(t, () => false).key).not.toBe(k1);
  });

  it('色を値の入力につなぐと明るさに、値を色の入力につなぐと灰色に変換する', () => {
    const t = createTree();
    const bsdf = surfaceShader(t)!;
    const rgb = addNode(t, 'rgb'), v = addNode(t, 'value');
    connect(t, { node: rgb.id, socket: 'color' }, { node: bsdf.id, socket: 'metallic' });
    connect(t, { node: v.id, socket: 'value' }, { node: bsdf.id, socket: 'baseColor' });
    const code = generate(t, () => false);
    expect(code.metallic).toContain(`dot(v_${rgb.id}_color`);
    expect(code.base).toBe(`vec3(v_${v.id}_value)`);
  });

  it('ノーマルマップ ← 画像テクスチャ を法線につなぐと、その画像を法線マップに使う', () => {
    const t = createTree();
    const bsdf = surfaceShader(t)!;
    const img = addNode(t, 'image'), nm = addNode(t, 'normalMap');
    img.props.image = 'n';
    connect(t, { node: img.id, socket: 'color' }, { node: nm.id, socket: 'color' });
    connect(t, { node: nm.id, socket: 'normal' }, { node: bsdf.id, socket: 'normal' });
    expect(generate(t, () => true).normalMap).toEqual({ image: 'n', node: nm.id });
  });

  it('サーフェスにシェーダーがつながっていなければ黒', () => {
    const t = createTree();
    disconnect(t, { node: t.nodes.find(n => n.type === 'output')!.id, socket: 'surface' });
    expect(generate(t, () => false).base).toBe('vec3(0.0)');
  });
});

describe('色の変換', () => {
  it('リニアな色と画面の色 (#rrggbb) を行き来する', () => {
    expect(linearToHex([1, 1, 1])).toBe('#ffffff');
    expect(linearToHex([0.2158, 0.2158, 0.2158])).toBe('#808080');
    const lin = hexToLinear('#808080');
    expect(lin[0]).toBeCloseTo(0.2158, 3);
    expect(linearToHex(hexToLinear('#3366cc'))).toBe('#3366cc');
  });
});
