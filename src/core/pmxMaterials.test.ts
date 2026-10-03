import { MMDParser } from 'three/examples/jsm/libs/mmdparser.module.js';
import { describe, expect, it } from 'vitest';
import { makePmx } from '../../e2e/fixtures/pmx';
import { patchPmxMaterials, readPmxMaterials, type PmxMaterialValues } from './pmxMaterials';

const buf = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (b: ArrayBuffer): any => new MMDParser.Parser().parsePmx(b, false);
const values: PmxMaterialValues = {
  diffuse: [0.25, 0.5, 0.75, 0.5],
  specular: [0.1, 0.2, 0.3],
  specularPower: 12,
  ambient: [0.4, 0.3, 0.2],
  edge: false,
  edgeColor: [1, 0, 0, 1],
  edgeSize: 2,
};

describe('readPmxMaterials', () => {
  it('頂点・面・テクスチャを読み飛ばして、材質の名前を読む (剛体のあるモデルでも)', () => {
    expect(readPmxMaterials(buf(makePmx()))).toMatchObject([{ name: '体' }]);
    expect(readPmxMaterials(buf(makePmx('x', { physics: true })))).toMatchObject([{ name: '体' }]);
  });
  it('.pmx でなければ例外', () => {
    expect(() => readPmxMaterials(new TextEncoder().encode('hello world!').buffer as ArrayBuffer)).toThrow('.pmx ファイルではありません');
  });
});

describe('patchPmxMaterials', () => {
  it('材質の色・反射・環境色・エッジを書き換え、MMD の読み込みでもその値になる', () => {
    const original = buf(makePmx('テスト人形', { physics: true }));
    const patched = buf(patchPmxMaterials(original, new Map([[0, values]])));
    const m = parse(patched).materials[0];
    expect(Array.from(m.diffuse as number[])).toEqual(values.diffuse);
    expect(Array.from(m.specular as number[]).map(v => +v.toFixed(5))).toEqual(values.specular);
    expect(m.shininess).toBe(12);
    expect(Array.from(m.ambient as number[]).map(v => +v.toFixed(5))).toEqual(values.ambient);
    expect(m.flag & 0x10).toBe(0);              // エッジを消した
    expect(m.flag & 0x01).toBe(1);              // ほかのフラグ (両面描画) はそのまま
    expect(Array.from(m.edgeColor as number[])).toEqual(values.edgeColor);
    expect(m.edgeSize).toBe(2);
  });

  it('材質のほかは、1 バイトも変えない (ボーン・表情・剛体などはそのまま)', () => {
    const original = new Uint8Array(buf(makePmx('テスト人形', { physics: true })));
    const patched = patchPmxMaterials(original.buffer as ArrayBuffer, new Map([[0, { ...values, edge: true }]]));
    expect(patched.length).toBe(original.length);
    const { offset } = readPmxMaterials(original.buffer as ArrayBuffer)[0];
    const changed = [...patched].map((b, i) => (b !== original[i] ? i : -1)).filter(i => i >= 0);
    // 拡散色 16・反射色 12・反射の強さ 4・環境色 12・フラグ 1・エッジ色 16・エッジサイズ 4 の中だけ
    expect(changed.every(i => i >= offset && i < offset + 65)).toBe(true);
    const before = parse(original.buffer as ArrayBuffer), after = parse(patched.buffer as ArrayBuffer);
    expect(after.bones).toEqual(before.bones);
    expect(after.morphs).toEqual(before.morphs);
    expect(after.rigidBodies).toEqual(before.rigidBodies);
    expect(after.constraints).toEqual(before.constraints);
  });

  it('ない材質の番号は例外', () => {
    expect(() => patchPmxMaterials(buf(makePmx()), new Map([[5, values]]))).toThrow('材質 5 がありません');
  });
});
