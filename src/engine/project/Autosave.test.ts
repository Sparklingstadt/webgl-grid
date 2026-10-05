import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../Engine';
import { AUTOSAVE_DELAY } from './Autosave';
import { memoryStore } from './autosaveStore';
import { engineWithCube } from '../testEngine';

// 自動保存と復元 (2 つのエンジン = ページを開き直した、として確かめる)
describe('Autosave', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const scene = (e: Engine) => e.world.objects.map(o => [o.s, o.x, o.z, o.c]);

  it('編集して少し待つと保存し、次に開いたときに前回の続きとして開ける', async () => {
    const store = memoryStore();
    const a = engineWithCube();
    await a.autosave.start(store);
    expect(a.ui.state.recovery).toBeNull();
    a.addShape(1);
    a.setObjColor(3);
    a.history.checkpoint();
    expect(await store.sessions()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY);
    await a.autosave.saveNow();
    expect(await store.sessions()).toHaveLength(1);

    const b = engineWithCube(); // 開き直したページ
    await b.autosave.start(store);
    expect(b.ui.state.recovery).toMatchObject({ banner: true, name: null });
    await b.autosave.recover();
    expect(scene(b)).toEqual(scene(a));
    expect(b.ui.state.recovery?.banner).toBe(false);
    expect(b.ui.state.toast?.text).toBe('前回の続きを開きました');
  });

  it('編集していなければ保存しない', async () => {
    const store = memoryStore();
    const a = engineWithCube();
    await a.autosave.start(store);
    a.clock.seekFrame(20); // いまのフレームは編集ではない
    a.history.checkpoint();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY * 2);
    await a.autosave.saveNow();
    expect(await store.sessions()).toHaveLength(0);
  });

  it('ファイルは一度だけしまい、最近の 3 回だけ残して、使わなくなったファイルは消す', async () => {
    const store = memoryStore();
    const put = vi.spyOn(store, 'putFile');
    const file = new File(['pmx'], 'a.pmx', { lastModified: 1 });
    for (let i = 0; i < 5; i++) {
      const e = engineWithCube();
      await e.autosave.start(store);
      // 参照するファイルがある場面のかわりに、保存の中身を差し替える
      vi.spyOn(e.project, 'saveReference').mockResolvedValue({ bytes: new TextEncoder().encode('{}'), files: new Map([['a1', i < 4 ? file : new File(['x'], 'b.pmx', { lastModified: 2 })]]) });
      e.addShape(0);
      e.history.checkpoint();
      await e.autosave.saveNow();
      vi.advanceTimersByTime(10); // 時刻をずらす
    }
    expect(put).toHaveBeenCalledTimes(2); // a.pmx と b.pmx を 1 回ずつ
    expect(await store.sessions()).toHaveLength(3);
    expect((await store.fileKeys()).sort()).toEqual(['a.pmx\0' + 3 + '\0' + 1, 'b.pmx\0' + 1 + '\0' + 2].sort());
  });
});
