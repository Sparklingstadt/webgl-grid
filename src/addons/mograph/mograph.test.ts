import { describe, expect, it } from 'vitest';
import { CLONER_DEFAULT, clonerLayout, normalizeCloner, type ClonerSettings } from '../cinema4d/cloner';
import { newEffector, type LayoutEnv } from '../cinema4d/effectors';
import { engineWithC4d } from '../cinema4d/testing';
import { EFFECTORS, makeEffectors, type EffectorDeps } from '.';
import { compile, evaluate, formula } from './expr';
import { analyze, levelAt, BANDS } from './sound';

const def = (k: string) => EFFECTORS.find(d => d.key === k)!;
const eff = (k: string, patch: object = {}) => ({ ...newEffector(def(k)), ...patch });
const env = (time = 0, origin = { x: 0, y: 0, z: 0, r: 0 }): LayoutEnv => ({ effector: k => EFFECTORS.find(d => d.key === k), time, origin });
const r = (v: number) => Math.round(v * 100) / 100 + 0;
const line = (effectors: ClonerSettings['effectors'], count = 3): ClonerSettings =>
  normalizeCloner({ ...CLONER_DEFAULT, mode: 'linear', count, step: [1, 0, 0], effectors });

describe('MoGraph エフェクタ', () => {
  it('プレーンは全部に同じだけ、ステップは最初の 0 から最後の値まで、ディレイは 1 つごとに遅らせる。重ねると上から順に', () => {
    expect(clonerLayout(line([eff('plain', { position: [0, 1, 0], scale: 2 })]), 100, env()).map(p => [r(p.y), r(p.scale)])).toEqual([[1, 2], [1, 2], [1, 2]]);
    expect(clonerLayout(line([eff('step', { rotationDeg: 90, scale: 3 })]), 100, env()).map(p => [r(p.ry), r(p.scale)])).toEqual([[0, 1], [0.79, 2], [1.57, 3]]);
    const delay = clonerLayout(line([eff('delay', { params: { frames: 4 } }), eff('delay', { params: { frames: 1 }, enabled: false })]), 100, env());
    expect(delay.map(p => p.delay)).toEqual([0, 4, 8]);
    expect(clonerLayout(line([eff('plain', { scale: 2 }), eff('step', { scale: 2 })]), 100, env()).map(p => r(p.scale))).toEqual([2, 3, 4]);
  });

  it('ランダム: クローンごとにばらつき、範囲に収まり、同じシードなら同じ', () => {
    const a = clonerLayout(line([eff('random', { position: [1, 0, 1], rotationDeg: 0, params: { seed: 3 } })], 20), 100, env());
    const b = clonerLayout(line([eff('random', { position: [1, 0, 1], rotationDeg: 0, params: { seed: 3 } })], 20), 100, env());
    const c = clonerLayout(line([eff('random', { position: [1, 0, 1], rotationDeg: 0, params: { seed: 4 } })], 20), 100, env());
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.every((p, i) => Math.abs(p.x - i) <= 1 && Math.abs(p.z) <= 1 && p.y === 0)).toBe(true);
    expect(new Set(a.map(p => r(p.z))).size).toBeGreaterThan(10);
  });

  it('フォーミュラ: 番号と時刻で波のように (sin)。タイム: 時刻 (秒) に合わせて強く', () => {
    const f = (t: number) => clonerLayout(line([eff('formula', { position: [0, 1, 0] })], 4), 100, env(t)).map(p => r(p.y));
    expect(f(0)).toEqual([0, 1, 0, -1]);
    expect(f(0.25)).toEqual([1, 0, -1, 0]); // 1 Hz で 1/4 周ずれる
    const t = clonerLayout(line([eff('time', { rotationDeg: 90 })], 2), 100, env(2)).map(p => r(p.ry));
    expect(t).toEqual([r(Math.PI), r(Math.PI)]);
  });

  it('ターゲット: クローンを決めた場所へ向ける (クローナーの位置と向きも考える)', () => {
    const toward = (o: { x: number; z: number; r: number }, origin = { ...o, y: 0 }) =>
      clonerLayout(line([eff('target', { params: { x: 1, z: 5 } })], 2), 100, env(0, origin)).map(p => r(p.ry));
    expect(toward({ x: 0, z: 0, r: 0 })).toEqual([r(Math.atan2(1, 5)), 0]);
    // クローナーを (1, 5) から見て真後ろへ回すと、向きは逆に
    expect(Math.abs(toward({ x: 1, z: 0, r: Math.PI })[0])).toBeCloseTo(Math.PI, 2);
  });

  it('時刻で変わるエフェクタは、描く前に置き場所を並べ直す', async () => {
    const { e, c4d } = await engineWithC4d();
    e.select(e.world.objects[0]);
    c4d.setCloner({ mode: 'linear', count: 4, step: [1, 0, 0], effectors: [eff('formula', { position: [0, 1, 0] })] });
    const ys = () => e.world.objects[0].node.getObjectByName('__clones')!.children.map(g => r(g.position.y));
    expect(ys()).toEqual([0, 1, 0, -1]);
    e.clock.seek(0.25);
    c4d.cloners.sync();
    expect(ys()).toEqual([1, 0, -1, 0]);
  });

  it('Cinema 4D が必要: 一緒に最初から有効。Cinema 4D を切ると一緒に切れ、有効にすると Cinema 4D も有効になる', async () => {
    const { e, c4d } = await engineWithC4d();
    expect(e.addons.isEnabled('mograph')).toBe(true);
    expect(c4d.effectors.list().filter(d => EFFECTORS.includes(d) || EFFECTORS.some(x => x.key === d.key)).map(d => d.key)).toEqual(['plain', 'step', 'random', 'formula', 'time', 'target', 'delay', 'shader', 'pushapart', 'volume', 'inheritance', 'sound']);
    expect(c4d.effectors.has('spline')).toBe(true); // (MoGraph スプラインのアドオンが足す)
    // エフェクタを切っても、クローナーの設定は残る (かからないだけ)
    e.select(e.world.objects[0]);
    c4d.setCloner({ mode: 'linear', count: 2, effectors: [eff('plain', { position: [0, 2, 0] })] });
    const y = () => e.world.objects[0].node.getObjectByName('__clones')!.children[0].position.y;
    expect(y()).toBe(2);
    e.addons.disable('mograph');
    expect(c4d.effectors.list().map(d => d.key)).toEqual(['spline']); // (MoGraph スプラインのものだけ残る)
    expect(y()).toBe(0);
    expect(c4d.cloner(e.world.objects[0])!.effectors).toHaveLength(1);
    await e.addons.enable('mograph');
    expect(y()).toBe(2);
    e.addons.disable('cinema4d');
    expect(e.addons.isEnabled('mograph')).toBe(false);
    await e.addons.enable('mograph');
    expect(e.addons.isEnabled('cinema4d')).toBe(true);
    expect(e.ui.state.addons.find(a => a.id === 'mograph')?.requires).toEqual(['cinema4d']);
  });
});

describe('フォーミュラの式', () => {
  it('四則・べき乗・関数 (三角関数は度)・変数を読み、JavaScript としては動かさない', () => {
    const v = { t: 0.25, f: 1, id: 2, count: 4, w: 1 };
    expect(evaluate('1 + 2 * 3 ^ 2', v)).toBe(19);
    expect(evaluate('-(2 - 5) % 2', v)).toBe(1);
    expect(evaluate('sin(90) + cos(180) + max(1, id, 3)', v)).toBeCloseTo(3);
    expect(evaluate('sin((t*f + id/count*w)*360)', v)).toBeCloseTo(-1);
    expect(evaluate('clamp(5) + clamp(-1, 0, 2) + pi', v)).toBeCloseTo(1 + Math.PI);
    expect(formula('sin(').error).toMatch(/途中|\)/);
    expect(formula('alert(1)').error).toBe('知らない関数です: alert');
    expect(formula('constructor').error).toBeNull(); // (変数としては読めるが…)
    expect(evaluate('constructor', v)).toBe(0); // (値がないので 0)
    expect(() => compile('1 +* 2')).toThrow();
  });
  it('フォーミュラ・エフェクタは式で強さを決め、読めない式はパネルに知らせる', () => {
    const l = clonerLayout(line([eff('formula', { position: [0, 1, 0], params: { expression: 'id * 0.5' } })], 3), 100, env());
    expect(l.map(p => r(p.y))).toEqual([0, 0.5, 1]);
    expect(def('formula').check!(eff('formula', { params: { expression: 'sin(' } }))).toBeTruthy();
    expect(def('formula').check!(eff('formula'))).toBeNull();
  });
});

describe('シェーダー・プッシュアパート・ボリューム・継承・サウンド', () => {
  const deps = (patch: Partial<EffectorDeps>): EffectorDeps => ({ bounds: () => null, worldLayout: () => [], sound: () => 0, hasSound: () => false, ...patch });
  const envWith = (d: EffectorDeps, time = 0): LayoutEnv => ({ effector: k => makeEffectors(d).find(x => x.key === k), time, origin: { x: 0, y: 0, z: 0, r: 0 } });

  it('シェーダー: 場所ごとに違う、なめらかな強さ (0〜1)', () => {
    const l = clonerLayout(line([eff('shader', { position: [0, 1, 0] })], 20), 100, env());
    expect(l.every(p => p.y >= 0 && p.y <= 1)).toBe(true);
    expect(new Set(l.map(p => r(p.y))).size).toBeGreaterThan(5);
  });
  it('プッシュアパート: 重なったクローンを、半径の距離まで離す', () => {
    const s = normalizeCloner({ ...CLONER_DEFAULT, mode: 'linear', count: 3, step: [0, 0, 0], effectors: [eff('pushapart', { params: { radius: 1, iterations: 20 } })] });
    const l = clonerLayout(s, 100, env());
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(Math.hypot(l[i].x - l[j].x, l[i].z - l[j].z)).toBeGreaterThan(0.95);
  });
  it('ボリューム: 選んだ物の箱の中のクローンだけに効く', () => {
    const d = deps({ bounds: id => (id === 7 ? { min: { x: 0.5, y: -1, z: -1 }, max: { x: 2.5, y: 1, z: 1 } } : null) });
    const l = clonerLayout(line([eff('volume', { position: [0, 1, 0], scale: 1, params: { target: 7 } })], 4), 100, envWith(d));
    expect(l.map(p => p.y)).toEqual([0, 1, 1, 0]);
  });
  it('継承: ほかのクローナーの置き場所へ近づける (フィールドの強さで途中まで)', () => {
    const d = deps({ worldLayout: () => [{ x: 0, y: 2, z: 5, ry: 1, scale: 2 }] });
    const l = clonerLayout(line([eff('inheritance', { params: { target: 3 } })], 2), 100, envWith(d));
    expect(l.map(p => [r(p.x), r(p.y), r(p.z), r(p.ry), r(p.scale)])).toEqual([[0, 2, 5, 1, 2], [0, 2, 5, 1, 2]]);
  });
  it('サウンド: 曲の大きさで強さを決め、クローンごとに帯域を受け持つ', () => {
    const d = deps({ sound: (_t, band) => (band === undefined ? 0.5 : band / (BANDS - 1)), hasSound: () => true });
    const bands = clonerLayout(line([eff('sound', { position: [0, 1, 0] })], 4), 100, envWith(d)).map(p => r(p.y));
    expect(bands).toEqual([0, r(4 / 15), r(8 / 15), r(12 / 15)]);
    const all = clonerLayout(line([eff('sound', { position: [0, 1, 0], params: { mode: 'all' } })], 2), 100, envWith(d)).map(p => p.y);
    expect(all).toEqual([0.5, 0.5]);
  });
  it('音の大きさ: 低い音は低い帯、高い音は高い帯が大きく、音のないところは 0', () => {
    const rate = 8000, n = rate * 2, s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = i < n / 2 ? Math.sin(2 * Math.PI * 100 * i / rate) : Math.sin(2 * Math.PI * 3000 * i / rate);
    const lv = analyze(s, rate);
    const loudest = (t: number) => { let b = 0; for (let k = 0; k < BANDS; k++) if (levelAt(lv, t, k) > levelAt(lv, t, b)) b = k; return b; };
    expect(loudest(0.5)).toBeLessThan(5);
    expect(loudest(1.5)).toBeGreaterThan(9);
    expect(levelAt(analyze(new Float32Array(rate), rate), 0.5)).toBe(0);
  });
});
