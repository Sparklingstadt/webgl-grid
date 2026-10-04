import type { ScriptCommand } from './script.ts';
import type { RenderState } from './states.ts';
import type { Dim } from './types.ts';

// --- コンパイラの出力の型。すべて JSON にできる ---
export interface Annotation { name: string; type: string; value: number[] | string }
// kind 'builtin' はコンパイラが足す uniform (mme_flipY・mme_viewport)
export interface UniformRef { name: string; glslName: string; type: string; kind: 'value' | 'sampler' | 'builtin'; stages: ('vertex' | 'fragment')[] }
export interface AttributeRef { semantic: string; glslName: string; type: 'float4' }
export interface Program { vertex: string; fragment: string; uniforms: UniformRef[]; attributes: AttributeRef[]; outputs: number; uniformVectors: number }
export interface Param {
  name: string; glslName: string; type: string; semantic: string | null; storage: 'uniform' | 'static' | 'const';
  annotations: Annotation[]; init: number[] | string | null;
}
export interface TextureDecl { name: string; type: string; semantic: string | null; annotations: Annotation[] }
export interface SamplerDecl { name: string; glslName: string; dim: Dim; texture: string | null; states: RenderState[] }
export interface Pass { name: string; annotations: Annotation[]; script: ScriptCommand[]; states: RenderState[]; program: Program | null }
export interface Technique { name: string; annotations: Annotation[]; script: ScriptCommand[]; passes: Pass[] }
export interface EffectDesc { params: Param[]; textures: TextureDecl[]; samplers: SamplerDecl[]; techniques: Technique[] }
