import type { History } from '../history/History';
import type { UiChannel } from '../UiChannel';

// --- マーカー (Blender のタイムラインのマーカー): フレームに名前を付けた印 ---
// タイムラインの上で M を押すと、いまのフレームに置く (名前は「F_12」のように)。1 つのフレームに 1 つだけ。
// タイムラインの下の帯で、押して選ぶ (Shift で足す)・左右にドラッグして動かす・ダブルクリックで名前を変える。
// 選んだマーカーは、右クリックのメニューか X で消す。プロジェクトに保存し、元に戻せる
export interface Marker { frame: number; name: string }
export const MAX_MARKER_NAME = 64;

export function normalizeMarkers(raw: unknown): Marker[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>(), out: Marker[] = [];
  for (const m of raw) {
    const frame = Math.round(Number(m?.frame));
    if (!Number.isFinite(frame) || frame < 0 || seen.has(frame)) continue;
    seen.add(frame);
    out.push({ frame, name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, MAX_MARKER_NAME) : markerName(frame) });
  }
  return out.sort((a, b) => a.frame - b.frame);
}
export const markerName = (frame: number) => `F_${String(frame).padStart(2, '0')}`;

export class Markers {
  list: Marker[] = [];
  readonly selected = new Set<number>(); // 選んだマーカーのフレーム

  constructor(private ui: UiChannel, private history: History) {}

  // いまのフレームに置く (もうあれば、それを選ぶ)
  add(frame: number) {
    frame = Math.max(0, Math.round(frame));
    if (!this.list.some(m => m.frame === frame)) {
      this.history.checkpoint();
      this.list = normalizeMarkers([...this.list, { frame, name: markerName(frame) }]);
    }
    this.select([frame], false);
    this.changed();
  }
  select(frames: number[], add: boolean) {
    if (!add) this.selected.clear();
    for (const f of frames) { if (add && this.selected.has(f)) this.selected.delete(f); else this.selected.add(f); }
    this.ui.bump('keysVersion');
  }
  // 選んだマーカーを delta フレーム動かす (動かした先のマーカーは上書き)
  move(delta: number) {
    if (!delta || !this.selected.size) return;
    this.history.checkpoint();
    const moving = this.list.filter(m => this.selected.has(m.frame)).map(m => ({ ...m, frame: Math.max(0, m.frame + delta) }));
    const to = new Set(moving.map(m => m.frame));
    this.list = normalizeMarkers([...moving, ...this.list.filter(m => !this.selected.has(m.frame) && !to.has(m.frame))]);
    this.selected.clear();
    for (const f of to) this.selected.add(f);
    this.changed();
  }
  // 選んだマーカーを消す。消したら true
  removeSelected() {
    if (!this.list.some(m => this.selected.has(m.frame))) return false;
    this.history.checkpoint();
    this.list = this.list.filter(m => !this.selected.has(m.frame));
    this.selected.clear();
    this.changed();
    return true;
  }
  rename(frame: number, name: string) {
    const m = this.list.find(x => x.frame === frame), n = name.trim().slice(0, MAX_MARKER_NAME);
    if (!m || !n || m.name === n) return;
    this.history.checkpoint();
    this.list = this.list.map(x => (x === m ? { ...x, name: n } : x));
    this.changed();
  }
  // 読み込み・元に戻す
  replace(list: Marker[]) {
    this.list = normalizeMarkers(list);
    for (const f of [...this.selected]) if (!this.list.some(m => m.frame === f)) this.selected.delete(f);
    this.ui.bump('keysVersion');
  }

  private changed() {
    this.ui.bump('keysVersion');
    this.history.soon();
  }
}
