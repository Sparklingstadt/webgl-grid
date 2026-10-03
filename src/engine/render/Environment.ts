import * as THREE from 'three';
import { VIEWPORT_BG } from '../../core/constants';
import { normalizeScene, sunDirection, type SceneSettings } from '../../core/scene';
import type { UiChannel } from '../UiChannel';
import { noOutline, type SceneGraph } from './SceneGraph';
import type { Viewport } from './Viewport';

type Patch = { [K in keyof SceneSettings]?: SceneSettings[K] extends object ? Partial<SceneSettings[K]> : SceneSettings[K] };

// --- シーンの設定 (Cinema 4D の空・床・太陽) を場面に反映する ---
// 空は、描くたびに最初に全面へ描く (カメラの向きから空の向きを求め、地平線から上へグラデーション)。
// シーンには入れない (影の濃さ (GTAO) の法線を描くときに、背景まで法線で描かれてしまうため)
export class Environment {
  settings: SceneSettings = normalizeScene(undefined);
  private readonly skyScene = new THREE.Scene();
  private readonly skyCamera = new THREE.Camera();
  private readonly sky = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      gradient: { value: false }, top: { value: new THREE.Color() }, bottom: { value: new THREE.Color() },
      invProj: { value: new THREE.Matrix4() }, camWorld: { value: new THREE.Matrix4() },
    },
    vertexShader: 'varying vec2 vNdc; void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      uniform bool gradient;
      uniform vec3 top, bottom;
      uniform mat4 invProj, camWorld;
      varying vec2 vNdc;
      void main() {
        vec3 c = top;
        if (gradient) {
          // 画面の点から、その方向の空の向きを出す (上向きの成分で、地平線 → 真上へ)
          vec4 v = invProj * vec4(vNdc, 1.0, 1.0);
          vec3 dir = normalize((camWorld * vec4(v.xyz / v.w, 0.0)).xyz);
          c = mix(bottom, top, sqrt(clamp(dir.y, 0.0, 1.0)));
        }
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  // 床 (Cinema 4D の床オブジェクト): 果てしなく広い板。グリッドより少し下に置く
  private readonly floor = new THREE.Mesh(
    new THREE.CircleGeometry(1000, 96).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ userData: noOutline() }),
  );

  constructor(private graph: SceneGraph, private viewport: Viewport, private ui: UiChannel) {
    this.skyScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.sky));
    this.floor.position.y = -0.002;
    this.floor.receiveShadow = true;
    this.floor.name = 'floor';
    graph.scene.add(this.floor);
    viewport.drawBackground = (r, camera) => this.drawSky(r, camera);
    this.apply();
  }

  // 設定を変える (渡したところだけ)
  set(patch: Patch) {
    const s = this.settings;
    this.settings = normalizeScene({ ...s, ...patch, sky: { ...s.sky, ...patch.sky }, floor: { ...s.floor, ...patch.floor }, sun: { ...s.sun, ...patch.sun } });
    this.apply();
  }
  reset() { this.replace(normalizeScene(undefined)); }
  // 設定をまるごと入れ替える (元に戻す・プロジェクトを開く)
  replace(s: SceneSettings) { this.settings = normalizeScene(s); this.apply(); }

  private apply() {
    const { sky, floor, sun, environment } = this.settings;
    const u = this.sky.uniforms;
    u.gradient.value = sky.mode === 'gradient';
    u.top.value.set(sky.mode === 'viewport' ? VIEWPORT_BG : sky.top); // (リニアに変換される)
    u.bottom.value.set(sky.bottom);
    const fm = this.floor.material;
    this.floor.visible = floor.enabled;
    fm.color.set(floor.color);
    fm.roughness = floor.roughness;
    this.graph.setFloor(floor.enabled);
    this.graph.setSun(sunDirection(sun.azimuthDeg, sun.elevationDeg), sun.intensity * Math.PI, sun.color, sun.shadows);
    this.graph.scene.environmentIntensity = environment;
    this.ui.set({ scene: this.settings });
    this.viewport.requestDraw();
  }

  private drawSky(r: THREE.WebGLRenderer, camera: THREE.Camera) {
    const u = this.sky.uniforms;
    u.invProj.value.copy(camera.projectionMatrixInverse);
    u.camWorld.value.copy(camera.matrixWorld);
    r.render(this.skyScene, this.skyCamera);
  }
}
