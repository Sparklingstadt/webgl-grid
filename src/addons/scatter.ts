import type { AddonModule } from '../engine/extend/Addons';

// --- ランダムに散らす: 選んだ形を、まわりにランダムに置く (重なれば積む) ---
// (メニュー・MCP の命令から、アプリの操作を呼ぶ例)
const scatter: AddonModule = {
  id: 'scatter',
  name: 'ランダムに散らす',
  version: '1.0.0',
  author: 'webgl-grid',
  category: 'オブジェクト',
  description: '選んだ形と同じ形 (同じマテリアル) を、まわりにランダムに置きます。「オブジェクト > ランダムに散らす」から使います。',
  register(api) {
    const { engine } = api;
    // 同じシードなら同じ並び (mulberry32)
    const rand = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const run = (count: number, radius: number, seed: number) => {
      const src = engine.selection.current;
      if (!src || src.s === 3 || src.light) throw new Error('散らす形をクリックして選んでください (MMD モデルとライトは散らせません)');
      const r = rand(seed), made: number[] = [];
      for (let i = 0; i < count && !engine.world.full; i++) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * radius;
        const o = engine.world.addShape(src.s, src.x + Math.cos(a) * d, src.z + Math.sin(a) * d, src.c);
        o.r = r() * Math.PI * 2;
        src.slots.forEach((id, k) => engine.world.setSlot(o, k, id));
        engine.world.dropIn(o);
        made.push(o.id);
      }
      engine.viewport.requestDraw();
      api.toast(`${made.length} 個置きました`);
      return made;
    };
    api.addMenuItem({
      menu: 'object', label: 'ランダムに散らす (10 個)',
      enabled: () => { const o = engine.selection.current; return !!o && o.s !== 3 && !o.light && !engine.world.full; },
      run: () => { try { run(10, 3, Date.now() % 100000); } catch (err) { api.toast((err as Error).message); } },
    });
    api.addCommand('run', {
      description: '選んでいる形を、まわりにランダムに置く',
      params: { count: '数 (既定 10)', radius: '半径 (既定 3)', seed: '乱数の種 (同じなら同じ並び)' },
      run: p => ({ ids: run(Number(p.count ?? 10), Number(p.radius ?? 3), Number(p.seed ?? 1)) }),
    });
  },
};
export default scatter;
