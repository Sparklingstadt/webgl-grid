import { errorText } from '../../core/errors';
import { t } from '../../core/i18n';
import type { History } from '../history/History';
import type { UiChannel } from '../UiChannel';
import type { AutosaveSession, AutosaveStore } from './autosaveStore';
import type { ProjectIO } from './ProjectIO';

export const AUTOSAVE_DELAY = 3000; // 最後の変更から保存するまで (ミリ秒)
const KEEP_SESSIONS = 3;           // 残しておく、ページを開いた回の数

const fileKey = (f: File) => `${f.name}\0${f.size}\0${f.lastModified}`;

// --- 自動保存と復元 (Blender の「前回のセッションを復元」) ---
// 編集して少し待ったら、ブラウザの中 (IndexedDB) に場面を保存する。中身は参照だけのプロジェクト (.wgpj) と、
// それが参照するファイル (モデルなど。一度しまったら、しまい直さない)。ページを開くたびに別の回として残し、最近の 3 回を持つ。
// 次に開いたとき、前の回があれば「前回の続き」を出す
export class Autosave {
  readonly session = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  private store: AutosaveStore | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(private project: ProjectIO, private history: History, private ui: UiChannel) {
    history.events.on('changed', () => this.schedule());
  }

  // 置き場所を決めて始める (ページを開いたとき)。前の回があれば知らせる
  async start(store: AutosaveStore | null) {
    this.store = store;
    if (!store) return;
    const prev = await this.previous();
    this.ui.set({ recovery: prev ? { time: prev.time, name: prev.name, banner: true } : null });
    if (this.dirty) this.schedule();
  }

  schedule() {
    this.dirty = true;
    clearTimeout(this.timer);
    if (this.store) this.timer = setTimeout(() => void this.saveNow(), AUTOSAVE_DELAY);
  }
  // 待たずに保存する (ページを隠したときなど)。編集していなければ何もしない
  saveNow() {
    clearTimeout(this.timer);
    this.saving = this.saving.then(() => this.save()).catch(err => console.error('自動保存できませんでした', err));
    return this.saving;
  }

  private async save() {
    const store = this.store;
    if (!store || !this.dirty) return;
    this.dirty = false;
    const { bytes, files } = await this.project.saveReference();
    const map: Record<string, string> = {};
    for (const [id, f] of files) {
      const key = fileKey(f);
      if (!(await store.hasFile(key))) await store.putFile(key, f);
      map[id] = key;
    }
    await store.putSession({ id: this.session, time: Date.now(), name: this.ui.state.projectName, json: new TextDecoder().decode(bytes), files: map });
    await this.prune(store);
  }
  // 古い回と、どの回も使わないファイルを消す
  private async prune(store: AutosaveStore) {
    const all = (await store.sessions()).sort((a, b) => b.time - a.time);
    for (const s of all.slice(KEEP_SESSIONS)) await store.deleteSession(s.id);
    const used = new Set(all.slice(0, KEEP_SESSIONS).flatMap(s => Object.values(s.files)));
    for (const k of await store.fileKeys()) if (!used.has(k)) await store.deleteFile(k);
  }

  // いまの回より前の、いちばん新しい回
  private async previous(): Promise<AutosaveSession | null> {
    if (!this.store) return null;
    const list = (await this.store.sessions()).filter(s => s.id !== this.session).sort((a, b) => b.time - a.time);
    return list[0] ?? null;
  }

  // 前の回を開く
  async recover() {
    const store = this.store, prev = await this.previous();
    this.dismiss();
    if (!store || !prev) { this.ui.toast(t('前回の続きはありません')); return; }
    this.ui.toast(t('前回の続きを開いています…'), 0);
    try {
      const provided = new Map<string, File>();
      for (const [id, key] of Object.entries(prev.files)) {
        const f = await store.getFile(key);
        if (f) provided.set(id, f);
      }
      let missing = 0;
      await this.history.batch(() => this.project.open(new TextEncoder().encode(prev.json), {
        provided, pick: async m => { missing = m.length; return 'skip'; },
      }));
      this.ui.set({ projectName: prev.name });
      this.ui.toast(missing ? t('前回の続きを開きました (見つからないファイルが {n} 個あります)', { n: missing }) : t('前回の続きを開きました'), missing ? 8000 : 4000);
    } catch (err) {
      console.error(err);
      this.ui.toast(t('前回の続きを開けませんでした: {error}', { error: errorText(err) }), 8000);
    }
  }
  // 「前回の続き」の知らせを閉じる (ファイル メニューからは開ける)
  dismiss() {
    const r = this.ui.state.recovery;
    if (r) this.ui.set({ recovery: { ...r, banner: false } });
  }
}
