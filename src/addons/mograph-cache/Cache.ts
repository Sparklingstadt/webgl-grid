import { msg } from '../../core/i18n';
import type { AddonApi, ObjectData } from '../../engine/addons/Addons';
import type { Obj } from '../../engine/types';
import type { Cinema4d } from '../cinema4d/Cinema4d';
import type { Placement } from '../cinema4d/cloner';

// --- MoGraph キャッシュ (Cinema 4D の MoGraph キャッシュタグ): クローナーの置き場所をフレームごとに焼き付ける ---
// 開始〜終了の各フレームへ時刻を進めて、エフェクタで計算した置き場所を覚える。焼き付けたあとは、再生・レンダリング・時刻を飛ぶときも
// 計算せずにそれを使う (重いエフェクタでも軽く、いつも同じ結果)。物ごとの値なので、元に戻す・プロジェクトにも残る。消すと計算に戻る
export interface CacheData {
  start: number;      // 最初のフレーム
  count: number;      // クローンの数
  frames: number[][]; // フレームごと: クローンごとに x・y・z・ry・scale・delay を並べたもの
}
const PER = 6, MAX_NUMBERS = 3_000_000; // (クローン 1 つの値の数・覚える値の数の上限)
const round = (v: number) => Math.round(v * 1e4) / 1e4;
export function normalizeCache(raw: unknown): CacheData | null {
  const c = raw as Partial<CacheData> | null;
  if (!c || !Array.isArray(c.frames) || !c.frames.length || typeof c.start !== 'number' || typeof c.count !== 'number') return null;
  const count = Math.max(0, Math.floor(c.count));
  const frames = c.frames.filter(f => Array.isArray(f) && f.length === count * PER && f.every(v => typeof v === 'number' && Number.isFinite(v)));
  return frames.length === c.frames.length && count * PER * frames.length <= MAX_NUMBERS ? { start: Math.floor(c.start), count, frames } : null;
}

export class Cache {
  private readonly data: ObjectData<CacheData>;
  private on = true;

  constructor(private api: AddonApi, private c4d: Cinema4d) {
    this.data = api.addObjectData<CacheData>({ key: 'cache', label: msg('MoGraph キャッシュ'), normalize: normalizeCache, apply: o => c4d.cloners.rebuild(o) });
    c4d.cloners.cacheOf = (o, frame) => this.placements(o, frame);
  }
  off() {
    this.on = false;
    if (this.c4d.cloners.cacheOf) this.c4d.cloners.cacheOf = null;
    for (const o of this.api.engine.world.objects) if (this.data.get(o)) this.c4d.cloners.rebuild(o);
  }

  get(o: Obj | null | undefined) { return o && this.on ? this.data.get(o) : null; }

  // そのフレームの置き場所 (範囲の外は、いちばん近い端のフレーム)。クローンの数が変わっていたら使わない
  placements(o: Obj, frame: number): Placement[] | null {
    const c = this.get(o);
    if (!c || !this.c4d.cloner(o) || this.c4d.count(o) !== c.count) return null;
    const f = c.frames[Math.min(Math.max(Math.round(frame) - c.start, 0), c.frames.length - 1)];
    return Array.from({ length: c.count }, (_, i) => ({ x: f[i * PER], y: f[i * PER + 1], z: f[i * PER + 2], ry: f[i * PER + 3], scale: f[i * PER + 4], delay: f[i * PER + 5] }));
  }

  // 開始〜終了を焼き付ける (いまのフレームに戻す)。焼き付けたフレームの数を返す
  bake(o: Obj) {
    const e = this.api.engine, cloner = this.c4d.cloner(o);
    if (!cloner) throw new Error(msg('クローナーにしている物を選んでください'));
    const { start, end } = e.clock, back = e.clock.frame;
    const frames: number[][] = [];
    let count = 0;
    this.data.set(o, null); // (古いキャッシュを使わずに計算する)
    for (let f = start; f <= end; f++) {
      e.clock.seekFrame(f, 0);
      const ps = this.c4d.cloners.compute(o, cloner);
      count = ps.length;
      if (count * PER * (frames.length + 1) > MAX_NUMBERS) break;
      frames.push(ps.flatMap(p => [round(p.x), round(p.y), round(p.z), round(p.ry), round(p.scale), p.delay]));
    }
    e.clock.seekFrame(back);
    this.data.set(o, { start, count, frames });
    return frames.length;
  }
  clear(o: Obj) { this.data.set(o, null); }
}
