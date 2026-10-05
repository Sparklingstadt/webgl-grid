import type { ScriptCommand } from './script.ts';
import type { RenderState } from './states.ts';
import type { Dim } from './types.ts';

// --- コンパイラの出力の型。すべて JSON にできる ---
export interface Annotation { name: string; type: string; value: number[] | string }
// kind 'builtin' はコンパイラが足す uniform (mme_flipY・mme_halfPixel・mme_viewport)。
// upload 'mat4': 非正方の行列 (とその配列) は GLSL では mat4 で宣言するので、1 つを 16 個の数 (HLSL の行 r・列 c が r * 4 + c、残りは 0) にして渡す
export interface UniformRef { name: string; glslName: string; type: string; kind: 'value' | 'sampler' | 'builtin'; stages: ('vertex' | 'fragment')[]; upload?: 'mat4' }
export interface AttributeRef { semantic: string; glslName: string; type: 'float4' }
export interface Program { vertex: string; fragment: string; uniforms: UniformRef[]; attributes: AttributeRef[]; outputs: number; uniformVectors: number }
export interface Param {
  name: string; glslName: string; type: string; semantic: string | null; storage: 'uniform' | 'static' | 'const';
  annotations: Annotation[]; init: number[] | string | null;
  shared: boolean; // HLSL の shared 修飾子 (エフェクトをまたいで共有する)
}
export interface TextureDecl { name: string; type: string; semantic: string | null; annotations: Annotation[]; shared: boolean }
export interface SamplerDecl { name: string; glslName: string; dim: Dim; texture: string | null; states: RenderState[]; register: string | null }
export interface Pass { name: string; annotations: Annotation[]; script: ScriptCommand[]; states: RenderState[]; program: Program | null }
export interface Technique { name: string; annotations: Annotation[]; script: ScriptCommand[]; passes: Pass[] }
export interface EffectDesc { params: Param[]; textures: TextureDecl[]; samplers: SamplerDecl[]; techniques: Technique[] }
