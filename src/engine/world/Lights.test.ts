import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Engine } from '../Engine';

// ライト (描画先なしのエンジンで)
const lightOf = (e: Engine, i: number) => {
  let l: THREE.Light | null = null;
  e.world.objects[i].node.traverse(o => { if ((o as THREE.Light).isLight) l = o as THREE.Light; });
  return l as THREE.Light | null;
};

describe('ライト', () => {
  it('置くと決めた高さに浮かび、積み重ねには加わらない (下に物を運んでも、上に物が載らない)', () => {
    const e = new Engine();
    const light = e.addLight('point')!;
    expect(e.ui.state.sel).toMatchObject({ kind: 'light', name: '点光源' });
    expect(light.y).toBe(3.5);
    expect(lightOf(e, 1)).toBeInstanceOf(THREE.PointLight);
    // 立方体をライトの真下に動かしても、ライトの高さは変わらず、立方体も持ち上がらない
    const cube = e.world.objects[0];
    e.select(cube);
    e.setObjProp('x', light.x);
    e.setObjProp('z', light.z);
    expect([cube.y, light.y]).toEqual([0, 3.5]);
  });

  it('種類・高さ・スポットの広がりと傾きを変えられ、元に戻せる', async () => {
    const e = new Engine();
    e.addLight('point');
    e.history.checkpoint();
    e.setLight({ type: 'spot', height: 5, angleDeg: 20, tiltDeg: 30 });
    e.history.checkpoint();
    const spot = lightOf(e, 1) as THREE.SpotLight;
    expect(spot).toBeInstanceOf(THREE.SpotLight);
    expect(spot.angle).toBeCloseTo(20 * Math.PI / 180);
    expect(spot.target.position.toArray().map(v => +v.toFixed(3))).toEqual([0, -0.866, 0.5]); // 真下から 30° 前へ
    expect(e.world.objects[1].y).toBe(5);
    expect(e.ui.state.history.labels.at(-1)).toBe('ライト');
    await e.history.undo();
    expect(lightOf(e, 1)).toBeInstanceOf(THREE.PointLight);
    expect(e.world.objects[1].y).toBe(3.5);
  });

  it('プロジェクトに保存して開くと、ライトも戻る', async () => {
    const e = new Engine();
    e.addLight('spot', { color: '#ff8800', intensity: 120 });
    const bytes = await e.project.save('reference');
    const f = new Engine();
    await f.project.open(bytes);
    expect(f.world.objects[1].light).toEqual(e.world.objects[1].light);
    expect((lightOf(f, 1) as THREE.SpotLight).color.getHexString()).toBe(new THREE.Color('#ff8800').getHexString());
  });
});
