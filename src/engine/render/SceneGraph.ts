import * as THREE from 'three';
import { DEFAULT_FOV } from '../../core/constants';

// MMD モデル以外の物には輪郭線を付けない (userData は材質ごとに書き込むので、毎回新しいオブジェクトを渡す)
export const noOutline = () => ({ outlineParameters: { visible: false } });

// --- 場面: シーン・カメラ・光・地面 ---
export class SceneGraph {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.05, 1000);
  private readonly light = new THREE.Vector3(0.6, 1.0, 0.35).normalize();
  private readonly sun = new THREE.DirectionalLight(0xffffff, 0.82 * Math.PI);
  readonly grid = makeGrid();
  // 地面に落ちる影 (グリッドの上に重ねる)
  readonly shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000).rotateX(-Math.PI / 2),
    new THREE.ShadowMaterial({ opacity: 0.45, depthWrite: false, userData: noOutline() }),
  );

  constructor() {
    // 全体を照らす光は、描き始めたときに部屋の環境 (Viewport.mount の RoomEnvironment) から当てる
    const { sun } = this;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target);
    this.shadowPlane.receiveShadow = true;
    this.shadowPlane.position.y = 0.0005;
    this.shadowPlane.renderOrder = 1;
    this.scene.add(this.grid, this.shadowPlane);
  }

  // 影は注視点 (x, z) のまわり、カメラの距離に合わせた広さだけ計算する
  aimShadows(x: number, z: number, dist: number) {
    const { sun } = this;
    const span = Math.max(12, dist * 1.2);
    sun.target.position.set(x, 0, z);
    sun.position.copy(sun.target.position).addScaledVector(this.light, 40);
    Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 100 });
    sun.shadow.camera.updateProjectionMatrix();
  }

  // ステージがあるあいだは、ステージの床とちらつかないよう地面のグリッドと影の板を隠す
  setGroundVisible(on: boolean) {
    this.grid.visible = this.shadowPlane.visible = on;
  }
}

// --- 地面のグリッド ---
function makeGrid() {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      userData: noOutline(),
      vertexShader: `
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vWorld;
        // 線幅(ピクセル単位)を一定に保つアンチエイリアス付きグリッド
        float grid(vec2 p, float lineWidth) {
          vec2 d = fwidth(p);
          vec2 g = abs(fract(p - 0.5) - 0.5) / d;
          float line = min(g.x, g.y);
          return 1.0 - clamp(line - lineWidth + 1.0, 0.0, 1.0);
        }
        void main() {
          // Blender のビューポートの床のように、面は塗らずに線だけを引く
          vec2 p = vWorld.xz;
          float minor = grid(p, 1.0), major = grid(p / 5.0, 1.0);
          vec3 c = mix(vec3(0.105), vec3(0.16), major);
          float a = max(minor * 0.55, major);
          // 原点の軸 (X: 赤, Z: 青。Blender の軸の色)
          vec2 ad = abs(p) / fwidth(p);
          float ax = 1.0 - clamp(ad.y - 1.0, 0.0, 1.0), az = 1.0 - clamp(ad.x - 1.0, 0.0, 1.0);
          c = mix(c, vec3(1.0, 0.033, 0.086), ax);
          c = mix(c, vec3(0.022, 0.278, 1.0), az);
          a = max(a, max(ax, az));
          // 遠くほど透明にして背景に溶かす
          float fade = exp(-distance(cameraPosition, vWorld) * 0.035);
          // 色はリニアで出し、画面用・後処理用の変換は three.js に任せる
          gl_FragColor = vec4(c, a * fade);
          #include <colorspace_fragment>
        }`,
    }),
  );
}
