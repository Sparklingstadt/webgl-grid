import { describe, expect, it } from 'vitest';
import { MME_DEFAULTS, normalizeMmeScene } from './settings.ts';

// プロジェクトの場面の値 'mme' (MmeScene) の読み方
describe('normalizeMmeScene', () => {
  const empty = { folders: [], posts: [], controls: {} };

  it('第 2 の計画の形 (いちばん上に engine がある = 設定だけ) は、settings にその値、ほかは空', () => {
    const old = { engine: 'mme', selfShadow: false, shadowDistance: 5000, groundShadow: true };
    expect(normalizeMmeScene(old)).toEqual({ settings: old, ...empty });
  });

  it('ない・壊れた値は既定の設定と空', () => {
    for (const raw of [undefined, null, 'mme', 3, [], {}]) expect(normalizeMmeScene(raw)).toEqual({ settings: MME_DEFAULTS, ...empty });
    expect(normalizeMmeScene({ settings: 'x', folders: 'x', posts: {}, controls: [] })).toEqual({ settings: MME_DEFAULTS, ...empty });
  });

  it('いまの形をそのまま読む', () => {
    const scene = {
      settings: { engine: 'mme', selfShadow: true, shadowDistance: 100, groundShadow: false },
      folders: [{ id: 'folder3', name: 'ray-mmd' }, { id: 'folder5', name: '' }],
      posts: [{ effect: { folder: 'folder3', path: 'ray.fx' }, enabled: false }, { effect: { folder: 'folder5', path: 'a/b.fx' }, enabled: true }],
      controls: { 'ray_controller.pmx': { 'SSAO+': 0.5, 'SunLight+': 1 } },
    };
    expect(normalizeMmeScene(structuredClone(scene))).toEqual(scene);
  });

  it('壊れた項を捨てる: フォルダ (id がない・builtin・同じ id)、ポストエフェクト (参照が壊れた)、コントローラーの値 (数でない)。値は 0〜1 に収める', () => {
    const raw = {
      settings: { engine: 'mme' },
      folders: [{ id: 'folder1', name: 'a' }, { id: '', name: 'b' }, { id: 'builtin', name: '' }, { id: 'folder1', name: 'c' }, { name: 'd' }, null, 'folder2', { id: 'folder2' }],
      posts: [
        { effect: { folder: 'folder1', path: 'p.fx' } }, // (enabled がなければオン)
        { effect: { folder: 'folder1' }, enabled: true }, { effect: 'hide', enabled: true }, { enabled: true }, null, 'p.fx',
        { effect: { folder: 'folder1', path: 'q.fx' }, enabled: 'no' },
      ],
      controls: { A: { x: 2, y: -1, z: 'big', w: Number.NaN, v: 0.25 }, B: 'x', C: { x: null }, '': { x: 1 } },
    };
    expect(normalizeMmeScene(raw)).toEqual({
      settings: { ...MME_DEFAULTS, engine: 'mme' },
      folders: [{ id: 'folder1', name: 'a' }, { id: 'folder2', name: '' }],
      posts: [{ effect: { folder: 'folder1', path: 'p.fx' }, enabled: true }, { effect: { folder: 'folder1', path: 'q.fx' }, enabled: true }],
      controls: { A: { x: 1, y: 0, v: 0.25 } },
    });
  });

  it('ステージの割り当て (stage) は物の割り当てと同じく読み、壊れた項を捨てる。何も残らなければ項を作らない', () => {
    const base = { settings: MME_DEFAULTS, folders: [], posts: [], controls: {} };
    const stage = { Main: { object: { folder: 'f', path: 'sky.fx' } }, MaterialMap: { object: 'hide', materials: { 0: { folder: 'f', path: 'm.fx' } } } };
    expect(normalizeMmeScene({ ...base, stage: structuredClone(stage) })).toEqual({ ...base, stage });
    expect(normalizeMmeScene({ ...base, stage: { Main: { object: { folder: 'f', path: 'sky.fx' }, materials: { x: 'hide' } }, '': { object: 'hide' } } }))
      .toEqual({ ...base, stage: { Main: { object: { folder: 'f', path: 'sky.fx' } } } });
    for (const bad of [null, 'x', [], {}, { Main: { object: { folder: '', path: 'a.fx' } } }]) {
      const r = normalizeMmeScene({ ...base, stage: bad });
      expect(r).toEqual(base);
      expect('stage' in r).toBe(false);
    }
    // 第 2 の計画の形にはない
    expect('stage' in normalizeMmeScene({ engine: 'mme', stage })).toBe(false);
  });
  it('ステージのパラメータの値 (stageParams: チャンネルの名前 → 値) は数の項だけ読む。何も残らなければ項を作らない', () => {
    const base = { settings: MME_DEFAULTS, folders: [], posts: [], controls: {} };
    const stageParams = { 'folder1/sky.fx:Strength': 3, 'folder1/sky.fx:Col:x': -0.5 };
    expect(normalizeMmeScene({ ...base, stageParams: { ...stageParams } })).toEqual({ ...base, stageParams });
    expect(normalizeMmeScene({ ...base, stageParams: { ...stageParams, a: 'x', b: Number.NaN, c: null, '': 1 } })).toEqual({ ...base, stageParams });
    for (const bad of [null, 'x', [], {}, { a: Number.POSITIVE_INFINITY }]) {
      const r = normalizeMmeScene({ ...base, stageParams: bad });
      expect(r).toEqual(base);
      expect('stageParams' in r).toBe(false);
    }
  });
});
