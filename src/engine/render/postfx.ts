import * as THREE from 'three';
import type { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js';

// --- 効果 (MME 風の後処理) ---
// MME の .fx (DirectX 用の HLSL) はブラウザでは動かせないので、よく使われる MME に近い効果を組み込みで用意する
//   光る       … AutoLuminous 風。明るい部分だけをにじませるブルーム
//   ふんわり   … Diffusion 風。画面全体に弱いブルームをかけて、やわらかい光のにじみを出す
//   被写界深度 … 注視点にピントを合わせ、それ以外をぼかす
//   影の濃さ   … SSAO 風 (GTAO)。物の接する所や隙間を暗くする
//   色調       … 色温度・彩度・明度
export const FX_KEYS = ['ao', 'dof', 'bloom', 'diffusion', 'color'] as const; // 後処理をかける順
export type FxKey = typeof FX_KEYS[number];
export type FxState = Record<FxKey, boolean>;
// 効果の強さ。光る・ふんわりはブルームの強さそのもの、被写界深度は標準のぼけに対する倍率、
// 影の濃さは 1 までが暗さの混ぜ具合、1 を超えると暗くなる範囲を広げる。
// 色調は、色温度 (-1 で青っぽく、1 で暖かく)・彩度 (0 で白黒)・明度 (1 がそのまま)
export const FX_LEVEL_DEFAULT = { ao: 1, dof: 1, bloom: 0.7, diffusion: 0.2, temp: 0, sat: 1, bright: 1 };
export type FxLevel = typeof FX_LEVEL_DEFAULT;

export interface PostFx {
  composer: import('three/examples/jsm/postprocessing/EffectComposer.js').EffectComposer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  passes: Record<FxKey, any>;
}

export async function createPostFx(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera,
                                   outline: OutlineEffect, width: number, height: number, drawBackground: (r: THREE.WebGLRenderer) => void): Promise<PostFx> {
  const [{ EffectComposer }, { Pass }, { UnrealBloomPass }, { BokehPass }, { GTAOPass }, { OutputPass }, { ShaderPass }] = await Promise.all([
    import('three/examples/jsm/postprocessing/EffectComposer.js'),
    import('three/examples/jsm/postprocessing/Pass.js'),
    import('three/examples/jsm/postprocessing/UnrealBloomPass.js'),
    import('three/examples/jsm/postprocessing/BokehPass.js'),
    import('three/examples/jsm/postprocessing/GTAOPass.js'),
    import('three/examples/jsm/postprocessing/OutputPass.js'),
    import('three/examples/jsm/postprocessing/ShaderPass.js'),
  ]);
  // (背景の空は drawBackground で描く。シーンには入れない: 影の濃さ (GTAO) の法線を描くときに、背景まで法線で描かれてしまうため)
  // 背景と、MMD の輪郭線 (OutlineEffect) ごとシーンを描く最初のパス
  class OutlineRenderPass extends Pass {
    constructor() { super(); this.needsSwap = false; }
    render(r: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
      r.setRenderTarget(this.renderToScreen ? null : readBuffer);
      r.clear();
      drawBackground(r);
      outline.autoClear = false; // 背景を消さずに上に描く
      outline.render(scene, camera);
      outline.autoClear = true;
    }
  }
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(width, height);
  const size = new THREE.Vector2(width, height);
  // 影の濃さは、縦横半分の解像度で計算する。ぼかしてから重ねるので見た目はほとんど変わらず、
  // GPU の時間は 1/4 ほどになる (高解像度の画面では、効果の中でいちばん重い)
  const ao = new GTAOPass(scene, camera, width, height);
  const aoSetSize = ao.setSize.bind(ao);
  ao.setSize = (w, h) => aoSetSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
  const passes: PostFx['passes'] = {
    ao,
    // ピントからの距離 × aperture だけぼかす (上限 maxblur は画面幅に対する割合)
    dof: new BokehPass(scene, camera, { focus: 10, aperture: 0.0025, maxblur: 0.02 }),
    // 引数は (大きさ, 強さ, 広がり, しきい値)。光るはごく明るい所だけ、ふんわりは全体に弱く
    bloom: new UnrealBloomPass(size, 0.7, 0.4, 0.95),
    diffusion: new UnrealBloomPass(size, 0.2, 0.7, 0),
    // 色調: ほかの効果のあと、画面に出す直前 (リニアな色) にかける
    color: new ShaderPass({
      uniforms: { tDiffuse: { value: null }, temp: { value: 0 }, sat: { value: 1 }, bright: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float temp, sat, bright;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          vec3 col = c.rgb;
          // 色温度: 暖かくするときは赤を残して青を弱め、青っぽくするときは逆にする
          vec3 warm = vec3(1.0, 0.86, 0.66), cool = vec3(0.72, 0.86, 1.0);
          col *= temp >= 0.0 ? mix(vec3(1.0), warm, temp) : mix(vec3(1.0), cool, -temp);
          // 彩度: 明るさ (輝度) だけの白黒との間で混ぜる
          float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = max(mix(vec3(l), col, sat), 0.0);
          // 明度
          col *= bright;
          gl_FragColor = vec4(col, c.a);
        }`,
    }),
  };
  composer.addPass(new OutlineRenderPass());
  for (const k of FX_KEYS) composer.addPass(passes[k]);
  composer.addPass(new OutputPass());
  return { composer, passes };
}

export function applyFxLevels(fx: PostFx, level: FxLevel) {
  const { ao, dof, bloom, diffusion, color } = fx.passes;
  bloom.strength = level.bloom;
  diffusion.strength = level.diffusion;
  dof.uniforms.aperture.value = 0.0025 * level.dof;
  dof.uniforms.maxblur.value = 0.02 * level.dof;
  ao.blendIntensity = Math.min(level.ao, 1);
  ao.updateGtaoMaterial({ radius: 0.6 * Math.max(level.ao, 1), scale: Math.max(level.ao, 1) });
  color.uniforms.temp.value = level.temp;
  color.uniforms.sat.value = level.sat;
  color.uniforms.bright.value = level.bright;
}
