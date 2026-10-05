import * as THREE from 'three';
import type { Pass } from '../../core/fx/index.ts';
import { t } from '../../core/i18n.ts';
import { runTechnique, type ScriptBackend } from '../../core/mme/script.ts';
import type { CameraState, LightState, SemanticContext } from '../../core/mme/semantics.ts';
import type { DrawBuiltins, EffectInstance } from './EffectInstance';
import type { LoadedEffect } from './EffectStore';
import type { DrawTarget, Framebuffers } from './Framebuffers';

// --- ポストエフェクトの入れ子 (設計書「1 フレームの流れ」の 1) と、Script の描画先の命令 (物の .fx と共通) ---

// 1 フレームの値。screen は canvas の大きさ (書き出し中は書き出しの大きさ。VIEWPORTPIXELSIZE と ViewportRatio の基準)
export interface FrameState {
  camera: CameraState; light: LightState; eye: THREE.Vector3; time: number; elapsed: number; selfShadow: boolean; screen: [number, number];
}

// 描画先に合わせた組み込みの値。半ピクセル: DX9 は画素の中心が整数の位置にあるので、GL で同じ値を補間させるには、
// 形を D3D の画面で右と下へ半画素ずらす (クリップ座標で x は +1 / 幅、y は D3D の下 = GL の −mme_flipY の向きに 1 / 高さ)
export function builtins(target: DrawTarget): DrawBuiltins {
  const [w, h] = target.size;
  return { flipY: target.flipY, halfPixel: [1 / w, -target.flipY / h], viewport: [w, h] };
}

type TargetCommands = Pick<ScriptBackend, 'setColorTarget' | 'setDepthTarget' | 'setClearColor' | 'setClearDepth' | 'setClearStencil' | 'clear' | 'loopCount' | 'setLoopIndex'>;

// 1 回の technique の実行での、Script が選んだ描画先 (名前。null は既定) と消す値。描画先は描く直前に Framebuffers で選ぶ
export class ScriptTargets {
  changed = false; // 描画先を替える命令があった
  private colors: (string | null)[] = [null, null, null, null];
  private depth: string | null = null;
  private clearColor: [number, number, number, number] = [0, 0, 0, 0];
  private clearDepth = 1;
  private clearStencil = 0;

  // target: いま選んでいる描画先 (null なら、最初に描くときに既定の描画先を選ぶ)
  constructor(private fb: Framebuffers, private effect: LoadedEffect, private inst: EffectInstance, private warn: (m: string) => void, private target: DrawTarget | null) {}

  // いまの描画先 (選び直す必要があれば選ぶ)
  current(): DrawTarget {
    if (!this.target) this.target = this.fb.bind(this.effect, this.colors, this.depth);
    return this.target;
  }

  // ほかの描画 (内側の場面) で描画先が替わったので、次に描くときに選び直す
  invalidate(): void {
    this.target = null;
  }

  commands(): TargetCommands {
    return {
      setColorTarget: (i, name) => {
        if (i > 3) { this.warn(t('RenderColorTarget{i} には対応していないので無視します (3 まで)', { i })); return; }
        if (name !== null && !this.fb.has(this.effect, name, 'color')) { this.warn(t('レンダーターゲット {name} がないので無視します', { name })); return; }
        this.colors[i] = name;
        this.select();
      },
      setDepthTarget: name => {
        if (name !== null && !this.fb.has(this.effect, name, 'depth')) { this.warn(t('深度のターゲット {name} がないので無視します', { name })); return; }
        this.depth = name;
        this.select();
      },
      setClearColor: p => { const v = this.value(p, 'ClearSetColor'); if (v) this.clearColor = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0]; },
      setClearDepth: p => { const v = this.value(p, 'ClearSetDepth'); if (v) this.clearDepth = v[0] ?? 1; },
      setClearStencil: p => { const v = this.value(p, 'ClearSetStencil'); if (v) this.clearStencil = v[0] ?? 0; },
      clear: what => {
        this.current();
        this.fb.clear(what === 'color' ? this.clearColor : null, what === 'depth' ? this.clearDepth : null, what === 'stencil' ? this.clearStencil : null);
        this.fb.afterDraw();
      },
      loopCount: p => this.inst.param(p)?.[0] ?? NaN,
      setLoopIndex: (p, i) => this.inst.setParam(p, [i]),
    };
  }

  private select(): void {
    this.target = null;
    this.changed = true;
  }

  private value(param: string, what: string): number[] | null {
    const v = this.inst.param(param);
    if (!v) this.warn(t('{what} のパラメータ {param} がありません', { what, param }));
    return v;
  }
}

export interface PostChainDeps {
  fb: Framebuffers;
  instance(e: LoadedEffect): EffectInstance;
  render(m: THREE.RawShaderMaterial, geometry: THREE.BufferGeometry): void; // 材質で形を描く (three.js の render の中)
  checkLink(m: THREE.RawShaderMaterial, inst: EffectInstance, effect: LoadedEffect): void; // 初めて描いた材質がリンクできたか
}

// 全面の四角: a_POSITION = (±1, ±1, 0, 1)、a_TEXCOORD0 = (u, v, 0, 1) で v = 0 が上。D3D の表 (時計回り) を向ける
function quadGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('a_POSITION', new THREE.Float32BufferAttribute([-1, 1, 0, 1, 1, 1, 0, 1, -1, -1, 0, 1, 1, -1, 0, 1], 4));
  g.setAttribute('a_TEXCOORD0', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1], 4));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  return g;
}

const IDENTITY = new THREE.Matrix4();

export class PostChain {
  readonly quad = quadGeometry();
  // canvas の代わりに描いた絵 (D3D の上の行がテクスチャの 1 行目) を、上下を返して canvas に写す (画素ごとにそのまま)
  private copy = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: 'in vec4 a_POSITION;\nvoid main() { gl_Position = vec4(a_POSITION.xy, 0.0, 1.0); }',
    fragmentShader: 'precision highp float;\nuniform sampler2D map;\nout vec4 color;\nvoid main() {\n  ivec2 p = ivec2(gl_FragCoord.xy);\n  color = texelFetch(map, ivec2(p.x, textureSize(map, 0).y - 1 - p.y), 0);\n}',
    uniforms: { map: { value: null } },
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, side: THREE.DoubleSide,
  });

  constructor(private d: PostChainDeps) {}

  // posts は一覧の順 (最後がいちばん外側)。scene は場面をいまの描画先に描く
  run(posts: LoadedEffect[], frame: FrameState, scene: (target: DrawTarget) => void): void {
    this.level(posts, posts.length - 1, frame, scene);
  }

  // canvas の代わりの絵を canvas に写す (canvas を描画先にしてから呼ぶ)
  present(tex: THREE.Texture): void {
    this.copy.uniforms.map.value = tex;
    this.copy.uniformsNeedUpdate = true;
    this.d.render(this.copy, this.quad);
  }

  dispose(): void {
    this.quad.dispose();
    this.copy.dispose();
  }

  // posts[k] の technique の Script を実行する。ScriptExternal で 1 つ内側 (k − 1。−1 は場面) を、そのとき選んでいる描画先に描く
  private level(posts: LoadedEffect[], k: number, frame: FrameState, scene: (target: DrawTarget) => void): void {
    const { fb } = this.d;
    const inner = () => (k > 0 ? this.level(posts, k - 1, frame, scene) : scene(fb.bindSurface(fb.defaultSurface)));
    const effect = posts[k];
    const inst = this.d.instance(effect);
    const tech = effect.result.ok ? effect.result.effect.techniques[0] : undefined;
    if (!tech || inst.stopped) { inner(); return; }
    const warn = (m: string) => inst.warn(m); // (そのエフェクトの警告)
    const st = new ScriptTargets(fb, effect, inst, warn, null);
    const outer = fb.defaultSurface;
    let external = false;
    const backend: ScriptBackend = {
      ...st.commands(),
      drawPass: (p, mode) => {
        if (mode === 'geometry') warn(t('ポストエフェクトの Draw=Geometry は無視します'));
        else if (!inst.stopped) this.drawBuffer(inst, effect, p, st.current(), frame);
      },
      drawExternal: () => {
        external = true;
        st.current();
        fb.defaultSurface = fb.current; // (内側にとっての既定の描画先)
        try { inner(); } finally { fb.defaultSurface = outer; }
        st.invalidate();
        st.current();
        fb.afterDraw();
      },
      warn,
    };
    runTechnique(tech, 'post', backend);
    if (!external) warn(t('ScriptExternal=Color がないので、内側 (場面) を描きません'));
  }

  // Draw=Buffer: 描画先いっぱいの四角を描く
  private drawBuffer(inst: EffectInstance, effect: LoadedEffect, p: Pass, target: DrawTarget, frame: FrameState): void {
    const m = inst.material(p, target.flipY, { kind: 'post', doubleSided: false });
    if (!m) return;
    const ctx: SemanticContext = {
      camera: frame.camera, light: frame.light, world: IDENTITY, material: null, pass: null,
      time: frame.time, elapsed: frame.elapsed, screen: frame.screen, selfShadow: frame.selfShadow,
    };
    inst.bind(m, p, ctx, builtins(target), { role: name => this.d.fb.colorTexture(effect, name) });
    this.d.render(m, this.quad);
    this.d.checkLink(m, inst, effect);
    this.d.fb.afterDraw();
  }
}
