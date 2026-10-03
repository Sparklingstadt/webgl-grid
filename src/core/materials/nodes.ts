// シェーダーノードの種類 (Blender のシェーダーエディターのノードを手本にする)。
// 色はリニアな [r, g, b] (Blender と同じく、画面の色に直すのは表示するときだけ)

export type Color3 = [number, number, number];
export type SocketKind = 'color' | 'float' | 'vector' | 'shader';
export type SocketValue = number | Color3;

export interface SocketDef {
  id: string;
  label: string;
  kind: SocketKind;
  default?: SocketValue;
  min?: number;
  max?: number;
  step?: number;
  linkable?: boolean; // false: 値を入れるだけで、ほかのノードからはつなげない
  noValue?: boolean;  // 値の欄を出さない (法線など)
}
export interface PropDef {
  id: string;
  label: string;
  kind: 'enum' | 'image';
  options?: [string, string][]; // [値, 表示名]
  default?: string;
}
export type NodeCategory = 'output' | 'shader' | 'texture' | 'input' | 'color' | 'converter' | 'vector';
export type NodeType = 'output' | 'principled' | 'image' | 'rgb' | 'value' | 'mix' | 'math' | 'normalMap';
export interface NodeTypeDef {
  type: NodeType;
  label: string;
  category: NodeCategory;
  width: number;
  inputs: SocketDef[];
  outputs: SocketDef[];
  props: PropDef[];
  // ノードの中に値を持つ (RGB の色・値ノードの値)。出力のソケットと同じ id で values に入れる
  ownValue?: SocketDef;
}

export const MIX_MODES: [string, string][] = [
  ['mix', 'ミックス'], ['multiply', '乗算'], ['add', '加算'], ['subtract', '減算'],
  ['screen', 'スクリーン'], ['darken', '比較 (暗)'], ['lighten', '比較 (明)'],
];
export const MATH_OPS: [string, string][] = [
  ['add', '加算'], ['subtract', '減算'], ['multiply', '乗算'], ['divide', '除算'],
  ['power', 'べき乗'], ['minimum', '最小'], ['maximum', '最大'],
];

const f = (id: string, label: string, def: number, min = 0, max = 1, extra: Partial<SocketDef> = {}): SocketDef =>
  ({ id, label, kind: 'float', default: def, min, max, step: (max - min) <= 1 ? 0.01 : 0.05, ...extra });
const c = (id: string, label: string, def: Color3, extra: Partial<SocketDef> = {}): SocketDef => ({ id, label, kind: 'color', default: def, ...extra });

export const NODE_TYPES: Record<NodeType, NodeTypeDef> = {
  output: {
    type: 'output', label: 'マテリアル出力', category: 'output', width: 150,
    inputs: [{ id: 'surface', label: 'サーフェス', kind: 'shader' }], outputs: [], props: [],
  },
  principled: {
    type: 'principled', label: 'プリンシプル BSDF', category: 'shader', width: 240,
    inputs: [
      c('baseColor', 'ベースカラー', [0.8, 0.8, 0.8]),
      f('metallic', 'メタリック', 0),
      f('roughness', '粗さ', 0.5),
      f('ior', 'IOR', 1.5, 1, 3, { linkable: false }),
      f('alpha', 'アルファ', 1),
      { id: 'normal', label: '法線', kind: 'vector', noValue: true },
      f('specular', 'スペキュラー IOR レベル', 0.5, 0, 1, { linkable: false }),
      f('transmission', '伝播ウェイト', 0, 0, 1, { linkable: false }),
      f('coat', 'コートウェイト', 0, 0, 1, { linkable: false }),
      f('coatRoughness', 'コートの粗さ', 0.03, 0, 1, { linkable: false }),
      f('sheen', 'シーンウェイト', 0, 0, 1, { linkable: false }),
      c('emissionColor', '放射カラー', [1, 1, 1]),
      f('emissionStrength', '放射の強さ', 0, 0, 20),
    ],
    outputs: [{ id: 'bsdf', label: 'BSDF', kind: 'shader' }],
    props: [],
  },
  image: {
    type: 'image', label: '画像テクスチャ', category: 'texture', width: 200,
    inputs: [],
    outputs: [{ id: 'color', label: 'カラー', kind: 'color' }, { id: 'alpha', label: 'アルファ', kind: 'float' }],
    props: [{ id: 'image', label: '画像', kind: 'image' }],
  },
  rgb: {
    type: 'rgb', label: 'RGB', category: 'input', width: 150,
    inputs: [], outputs: [{ id: 'color', label: 'カラー', kind: 'color' }], props: [],
    ownValue: c('color', 'カラー', [0.5, 0.5, 0.5]),
  },
  value: {
    type: 'value', label: '値', category: 'input', width: 150,
    inputs: [], outputs: [{ id: 'value', label: '値', kind: 'float' }], props: [],
    ownValue: f('value', '値', 0.5, 0, 1),
  },
  mix: {
    type: 'mix', label: 'ミックス (カラー)', category: 'color', width: 180,
    inputs: [f('factor', '係数', 0.5), c('a', 'A', [0.5, 0.5, 0.5]), c('b', 'B', [0.5, 0.5, 0.5])],
    outputs: [{ id: 'result', label: '結果', kind: 'color' }],
    props: [{ id: 'blend', label: '合成', kind: 'enum', options: MIX_MODES, default: 'mix' }],
  },
  math: {
    type: 'math', label: '数式', category: 'converter', width: 170,
    inputs: [f('a', '値', 0.5, -10, 10), f('b', '値', 0.5, -10, 10)],
    outputs: [{ id: 'value', label: '値', kind: 'float' }],
    props: [{ id: 'op', label: '演算', kind: 'enum', options: MATH_OPS, default: 'add' }],
  },
  normalMap: {
    type: 'normalMap', label: 'ノーマルマップ', category: 'vector', width: 170,
    inputs: [f('strength', '強さ', 1, 0, 10), c('color', 'カラー', [0.5, 0.5, 1])],
    outputs: [{ id: 'normal', label: '法線', kind: 'vector' }],
    props: [],
  },
};

// 追加メニューに並べる順
export const ADDABLE: { category: string; types: NodeType[] }[] = [
  { category: '入力', types: ['rgb', 'value'] },
  { category: 'シェーダー', types: ['principled'] },
  { category: 'テクスチャ', types: ['image'] },
  { category: 'カラー', types: ['mix'] },
  { category: 'コンバーター', types: ['math'] },
  { category: 'ベクトル', types: ['normalMap'] },
];

// 種類の違うソケットどうしをつなげるか (シェーダーはシェーダーにだけ。色・値・ベクトルは互いに変換する)
export const compatible = (from: SocketKind, to: SocketKind) => (from === 'shader') === (to === 'shader');
