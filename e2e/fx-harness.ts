import type { Page } from '@playwright/test';
import { compileEffect, type Program } from '../src/core/fx/index.ts';

// FX コンパイラの出力を本物の WebGL2 で動かす道具 (e2e の中だけで使う)。ページは about:blank でよい

// ページの中で: WebGL2 の文脈を作り、シェーダーをコンパイル・リンクして、失敗したものを返す
export async function linkAll(page: Page, programs: { name: string; vertex: string; fragment: string }[]): Promise<{ name: string; log: string }[]> {
  return page.evaluate(programs => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return [{ name: '(WebGL2)', log: 'WebGL2 が使えない' }];
    // 先に全部のコンパイルとリンクを頼んでから結果を見る (ドライバーが並べて進められる)
    const made = programs.map(p => {
      const vs = gl.createShader(gl.VERTEX_SHADER)!, fs = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(vs, p.vertex);
      gl.shaderSource(fs, p.fragment);
      gl.compileShader(vs);
      gl.compileShader(fs);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      return { name: p.name, vs, fs, prog };
    });
    const failed: { name: string; log: string }[] = [];
    for (const { name, vs, fs, prog } of made) {
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = [
          gl.getShaderParameter(vs, gl.COMPILE_STATUS) ? '' : `vertex: ${gl.getShaderInfoLog(vs)}`,
          gl.getShaderParameter(fs, gl.COMPILE_STATUS) ? '' : `fragment: ${gl.getShaderInfoLog(fs)}`,
          `link: ${gl.getProgramInfoLog(prog)}`,
        ].filter(Boolean).join('\n');
        failed.push({ name, log });
      }
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    }
    return failed;
  }, programs);
}

// 値のテストの HLSL: 本文だけなら、PS と全面の三角形の VS と technique を足す
function wrap(hlsl: string): string {
  if (/\btechnique\b/.test(hlsl)) return hlsl;
  return `float4 VS(float4 p : POSITION) : POSITION { return p; }
float4 PS() : COLOR0 { ${hlsl} }
technique T { pass P { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }
`;
}

// HLSL を 1 つ変換する (最初の technique の最初の pass)
export function compileOne(hlsl: string): Program {
  const src = new TextEncoder().encode(wrap(hlsl));
  const r = compileEffect('test.fx', p => (p === 'test.fx' ? src : null));
  if (!r.ok) throw new Error(r.errors.map(e => `${e.code} ${e.line}:${e.column} ${e.message}`).join('\n'));
  const program = r.effect.techniques[0]?.passes[0]?.program;
  if (!program) throw new Error('pass に program がない');
  return program;
}

// HLSL を 1 つ変換して、1x1 の RGBA32F (EXT_color_buffer_float) に全面の三角形で描き、出力ごとの値を読む。uniforms は名前 → 数の並び
export async function runPixel(page: Page, hlsl: string, uniforms: Record<string, number[]> = {}): Promise<number[][]> {
  const program = compileOne(hlsl);
  // HLSL の名前 → GLSL の名前 (mme_flipY は 1、mme_viewport は描画先の大きさ)
  const values: Record<string, number[]> = { mme_flipY: [1], mme_viewport: [1, 1] };
  for (const u of program.uniforms) if (Object.hasOwn(uniforms, u.name)) values[u.glslName] = uniforms[u.name];
  const result = await page.evaluate(({ vertex, fragment, outputs, values }) => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'WebGL2 が使えない';
    if (!gl.getExtension('EXT_color_buffer_float')) return 'EXT_color_buffer_float が使えない';
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const vs = shader(gl.VERTEX_SHADER, vertex), fs = shader(gl.FRAGMENT_SHADER, fragment);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_POSITION');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      return `${gl.getShaderInfoLog(vs)}\n${gl.getShaderInfoLog(fs)}\n${gl.getProgramInfoLog(prog)}`;
    }
    gl.useProgram(prog);
    // uniform: 型はリンクしたプログラムから読む。行列は D3D の行優先の数のまま、transpose = false で送る
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i)!;
      const name = info.name.replace(/\[0\]$/, '');
      const v = values[name];
      if (!v) continue;
      const loc = gl.getUniformLocation(prog, info.name);
      const f = new Float32Array(v), k = new Int32Array(v);
      switch (info.type) {
        case gl.FLOAT: gl.uniform1fv(loc, f); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(loc, f); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(loc, f); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(loc, f); break;
        case gl.INT: case gl.BOOL: gl.uniform1iv(loc, k); break;
        case gl.INT_VEC2: case gl.BOOL_VEC2: gl.uniform2iv(loc, k); break;
        case gl.INT_VEC3: case gl.BOOL_VEC3: gl.uniform3iv(loc, k); break;
        case gl.INT_VEC4: case gl.BOOL_VEC4: gl.uniform4iv(loc, k); break;
        case gl.FLOAT_MAT2: gl.uniformMatrix2fv(loc, false, f); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, f); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, f); break;
        case gl.FLOAT_MAT2x3: gl.uniformMatrix2x3fv(loc, false, f); break;
        case gl.FLOAT_MAT2x4: gl.uniformMatrix2x4fv(loc, false, f); break;
        case gl.FLOAT_MAT3x2: gl.uniformMatrix3x2fv(loc, false, f); break;
        case gl.FLOAT_MAT3x4: gl.uniformMatrix3x4fv(loc, false, f); break;
        case gl.FLOAT_MAT4x2: gl.uniformMatrix4x2fv(loc, false, f); break;
        case gl.FLOAT_MAT4x3: gl.uniformMatrix4x3fv(loc, false, f); break;
        default: return `uniform ${info.name} の型 0x${info.type.toString(16)} は送れない`;
      }
    }
    // 出力ごとに 1x1 の RGBA32F を 1 枚
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const attachments: number[] = [];
    for (let i = 0; i < outputs; i++) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 1, 1);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
      attachments.push(gl.COLOR_ATTACHMENT0 + i);
    }
    gl.drawBuffers(attachments);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return '描画先が作れない';
    // 全面の三角形 (D3D のクリップ座標。z = 0.5, w = 1)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0.5, 1, 3, -1, 0.5, 1, -1, 3, 0.5, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, 1, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const out: number[][] = [];
    for (let i = 0; i < outputs; i++) {
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
      const px = new Float32Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
      out.push([...px]);
    }
    const err = gl.getError();
    return err === gl.NO_ERROR ? out : `GL の誤り 0x${err.toString(16)}`;
  }, { vertex: program.vertex, fragment: program.fragment, outputs: program.outputs, values });
  if (typeof result === 'string') throw new Error(result);
  return result;
}
