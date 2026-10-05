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
      vi.spyOn(e.project, 'saveReference').mockResolvedValue({ bytes: new TextEncoder().encode('{}'), files: new Map([['a1', i < 4 ? file : new File(['x'], 'b.pmx', { lastModified: 2 })]]), mmePaths: new Map() });
      e.addShape(0);
      e.history.checkpoint();
      await e.autosave.saveNow();
      vi.advanceTimersByTime(10); // 時刻をずらす
    }
    expect(put).toHaveBeenCalledTimes(2); // a.pmx と b.pmx を 1 回ずつ
    expect(await store.sessions()).toHaveLength(3);
    expect((await store.fileKeys()).sort()).toEqual(['a.pmx\0' + 3 + '\0' + 1, 'b.pmx\0' + 1 + '\0' + 2].sort());
  });

  it('MME のフォルダの、名前も大きさも更新日時も同じで中身の違うファイル (別のフォルダのもの) を分けてしまい、前回の続きでそれぞれに戻す', async () => {
    const at = (path: string, text: string) => {
      const f = new File([text], path.slice(path.lastIndexOf('/') + 1), { lastModified: 5 });
      Object.defineProperty(f, 'webkitRelativePath', { value: path });
      return f;
    };
    const store = memoryStore();
    const a = engineWithCube();
    await a.autosave.start(store);
    const folder = await a.mme.store.addFolder([at('Ray/Default Ambient/spot.fx', 'technique B { }'), at('Ray/Default/spot.fx', 'technique A { }')]);
    a.mme.addPost(a.mme.store.effect(folder, 'Default/spot.fx'));
    a.mme.addPost(a.mme.store.effect(folder, 'Default Ambient/spot.fx'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY);
    await a.autosave.saveNow();
    expect(await store.fileKeys()).toHaveLength(2);

    const b = engineWithCube();
    await b.autosave.start(store);
    await b.autosave.recover();
    expect(b.mme.posts().map(p => (p.effect.result.ok ? p.effect.result.effect.techniques[0].name : null))).toEqual(['A', 'B']);
  });

  // (MME の場面の値は元に戻すの対象にしないので、履歴の changed では保存されない)
  it('MME の場面の値 (ステージの割り当て・設定) を変えただけでも保存する', async () => {
    const edits: [string, (e: Engine) => void][] = [
      ['ステージの割り当て', e => e.mme.assignStage('Main', null, 'hide')],
      ['設定', e => e.mme.set({ engine: 'mme' })],
    ];
    for (const [what, edit] of edits) {
      const store = memoryStore();
      const a = engineWithCube();
      await a.autosave.start(store);
      edit(a);
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY);
      await a.autosave.saveNow();
      expect(await store.sessions(), what).toHaveLength(1);
    }
    // (同じ値にしただけ・毎フレームの publish では保存しない)
    const store = memoryStore();
    const a = engineWithCube();
    await a.autosave.start(store);
    a.mme.set({ ...a.mme.settings });
    for (let i = 0; i < 3; i++) a.mme.publish();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY);
    await a.autosave.saveNow();
    expect(await store.sessions()).toHaveLength(0);
  });

  // (仮のコントローラーの値はコントローラーの物の値なので、元に戻すの手になり、履歴の changed で保存される)
  it('仮のコントローラーのスライダーを動かすと、履歴の手になって保存する', async () => {
    const store = memoryStore();
    const a = engineWithCube();
    const obj = a.addMmeObject({ kind: 'controller', name: 'ray_controller.pmx' });
    a.history.checkpoint();
    await a.autosave.start(store);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY);
    await a.autosave.saveNow();
    const saved = async () => (await store.sessions()).map(x => JSON.parse(x.json).objects.find((o: { kind: string }) => o.kind === 'mme')?.mmeValues ?? null);
    expect(await saved()).toEqual([null]);
    a.mme.setControl('ray_controller.pmx', 'SunLight+', 0.5);
    expect(obj.mmeValues).toEqual({ 'SunLight+': 0.5 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY + 100); // (履歴の手になってから、自動保存の待ち時間)
    expect(await saved()).toEqual([{ 'SunLight+': 0.5 }]);
  });
});
