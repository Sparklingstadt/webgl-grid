import { NODE_TYPES, type SocketDef, type SocketKind } from './nodes';
import { findNode, inputLink, surfaceShader, upstreamOrder, type NodeTree, type ShaderNode } from './tree';

// ノードツリーから、three.js の物理ベースの材質 (MeshPhysicalMaterial) に差し込む GLSL を組み立てる。
// つながっていない入力の値は uniform にするので、値を変えるだけならシェーダーを作り直さずに済む。
// 作るのは文字列だけ (three.js の材質に差し込むのは engine/materials/compile.ts)

export interface UniformSpec {
  name: string;
  kind: 'float' | 'vec3' | 'sampler';
  node: string;
  socket: string; // 値の入力・RGB/値ノードの値。画像テクスチャは 'image'
}
export interface ShaderCode {
  key: string;        // 形 (つなぎ方・ノードの種類・合成の種類・画像の有無) が同じなら同じ
  decls: string;      // uniform の宣言
  body: string;       // ノードを計算する文
  base: string;       // vec3 ベースカラー
  alpha: string;      // float
  metallic: string;
  roughness: string;
  emission: string;   // vec3 (放射カラー × 強さ)
  uniforms: UniformSpec[];
  // プリンシプル BSDF の法線が「ノーマルマップ ← 画像テクスチャ」なら、その画像と強さ (three.js の normalMap を使う)
  normalMap: { image: string; node: string } | null;
  // つなげない入力 (IOR など) の値。材質の値として入れる
  constants: { ior: number; specular: number; transmission: number; coat: number; coatRoughness: number; sheen: number };
}

const LUMA = 'vec3(0.2126, 0.7152, 0.0722)';
const glslType = (k: SocketKind) => (k === 'float' ? 'float' : 'vec3');
function convert(expr: string, from: SocketKind, to: SocketKind) {
  if (from === to || (from !== 'float' && to !== 'float')) return expr; // 色とベクトルはそのまま
  return to === 'float' ? `dot(${expr}, ${LUMA})` : `vec3(${expr})`;
}
function hash(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const MIX: Record<string, (a: string, b: string) => string> = {
  mix: (_a, b) => b,
  multiply: (a, b) => `${a} * ${b}`,
  add: (a, b) => `${a} + ${b}`,
  subtract: (a, b) => `${a} - ${b}`,
  screen: (a, b) => `vec3(1.0) - (vec3(1.0) - ${a}) * (vec3(1.0) - ${b})`,
  darken: (a, b) => `min(${a}, ${b})`,
  lighten: (a, b) => `max(${a}, ${b})`,
};
const MATH: Record<string, (a: string, b: string) => string> = {
  add: (a, b) => `${a} + ${b}`,
  subtract: (a, b) => `${a} - ${b}`,
  multiply: (a, b) => `${a} * ${b}`,
  divide: (a, b) => `(${b} != 0.0 ? ${a} / ${b} : 0.0)`,
  power: (a, b) => `pow(max(${a}, 0.0), ${b})`,
  minimum: (a, b) => `min(${a}, ${b})`,
  maximum: (a, b) => `max(${a}, ${b})`,
};

// hasImage: 画像の id に、使える画像があるか
export function generate(tree: NodeTree, hasImage: (id: string) => boolean): ShaderCode {
  const uniforms: UniformSpec[] = [];
  const lines: string[] = [];
  const shader = surfaceShader(tree);
  const constants = { ior: 1.5, specular: 0.5, transmission: 0, coat: 0, coatRoughness: 0.03, sheen: 0 };
  const varName = (n: ShaderNode, socket: string) => `v_${n.id}_${socket}`;
  const uniform = (n: ShaderNode, socket: string, kind: UniformSpec['kind']) => {
    const name = `u_${n.id}_${socket}`;
    if (!uniforms.some(u => u.name === name)) uniforms.push({ name, kind, node: n.id, socket });
    return name;
  };
  // 入力の式: つながっていれば相手の出力の変数、つながっていなければ uniform
  const input = (n: ShaderNode, def: SocketDef, want: SocketKind = def.kind): string => {
    const link = inputLink(tree, n.id, def.id);
    const from = link && findNode(tree, link.from.node);
    if (link && from) {
      const outDef = NODE_TYPES[from.type].outputs.find(o => o.id === link.from.socket)!;
      return convert(varName(from, link.from.socket), outDef.kind, want);
    }
    return convert(uniform(n, def.id, def.kind === 'float' ? 'float' : 'vec3'), def.kind, want);
  };
  const inDef = (n: ShaderNode, id: string) => NODE_TYPES[n.type].inputs.find(s => s.id === id)!;

  let base = 'vec3(0.0)', alpha = '1.0', metallic = '0.0', roughness = '1.0', emission = 'vec3(0.0)';
  let normalMap: ShaderCode['normalMap'] = null;
  if (shader) {
    for (const n of upstreamOrder(tree, shader.id)) {
      switch (n.type) {
        case 'rgb':
        case 'value': {
          const own = NODE_TYPES[n.type].ownValue!;
          lines.push(`${glslType(own.kind)} ${varName(n, own.id)} = ${uniform(n, own.id, own.kind === 'float' ? 'float' : 'vec3')};`);
          break;
        }
        case 'image': {
          const img = n.props.image;
          if (img && hasImage(img)) {
            const s = uniform(n, 'image', 'sampler');
            lines.push(`vec4 t_${n.id} = texture2D(${s}, vUv);`);
          } else {
            lines.push(`vec4 t_${n.id} = vec4(1.0, 0.0, 1.0, 1.0);`); // 画像がない (Blender と同じ赤紫)
          }
          lines.push(`vec3 ${varName(n, 'color')} = t_${n.id}.rgb;`, `float ${varName(n, 'alpha')} = t_${n.id}.a;`);
          break;
        }
        case 'mix': {
          const fac = `clamp(${input(n, inDef(n, 'factor'))}, 0.0, 1.0)`;
          const a = `a_${n.id}`, b = `b_${n.id}`;
          lines.push(`vec3 ${a} = ${input(n, inDef(n, 'a'))};`, `vec3 ${b} = ${input(n, inDef(n, 'b'))};`);
          const blend = MIX[n.props.blend] ?? MIX.mix;
          lines.push(`vec3 ${varName(n, 'result')} = mix(${a}, ${blend(a, b)}, ${fac});`);
          break;
        }
        case 'math': {
          const a = `(${input(n, inDef(n, 'a'))})`, b = `(${input(n, inDef(n, 'b'))})`;
          lines.push(`float ${varName(n, 'value')} = ${(MATH[n.props.op] ?? MATH.add)(a, b)};`);
          break;
        }
        case 'normalMap':
          lines.push(`vec3 ${varName(n, 'normal')} = vec3(0.0, 0.0, 1.0);`);
          break;
        case 'principled': {
          base = input(n, inDef(n, 'baseColor'));
          alpha = `clamp(${input(n, inDef(n, 'alpha'))}, 0.0, 1.0)`;
          metallic = `clamp(${input(n, inDef(n, 'metallic'))}, 0.0, 1.0)`;
          roughness = `clamp(${input(n, inDef(n, 'roughness'))}, 0.0, 1.0)`;
          emission = `${input(n, inDef(n, 'emissionColor'))} * ${input(n, inDef(n, 'emissionStrength'))}`;
          for (const k of Object.keys(constants) as (keyof typeof constants)[]) {
            const v = n.values[k];
            if (typeof v === 'number') constants[k] = v;
          }
          // 法線: ノーマルマップ ← 画像テクスチャ のときだけ使う
          const nl = inputLink(tree, n.id, 'normal');
          const nm = nl && findNode(tree, nl.from.node);
          const cl = nm?.type === 'normalMap' ? inputLink(tree, nm.id, 'color') : null;
          const img = cl && findNode(tree, cl.from.node);
          if (nm && img?.type === 'image' && img.props.image && hasImage(img.props.image)) normalMap = { image: img.props.image, node: nm.id };
          break;
        }
      }
    }
  }
  const decls = uniforms.map(u => `uniform ${u.kind === 'sampler' ? 'sampler2D' : u.kind} ${u.name};`).join('\n');
  const body = lines.join('\n');
  const key = hash([decls, body, base, alpha, metallic, roughness, emission, normalMap ? 'nm' : ''].join('|'));
  return { key, decls, body, base, alpha, metallic, roughness, emission, uniforms, normalMap, constants };
}
