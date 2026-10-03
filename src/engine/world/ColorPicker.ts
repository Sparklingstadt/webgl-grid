import type { Viewport } from '../render/Viewport';
import type { Obj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { World } from './World';

// --- 色選び (スマホで形をタップしたときに出すパレット) ---
export class ColorPicker {
  target: Obj | null = null; // パレットで色を変えている形

  constructor(world: World, private viewport: Viewport, private ui: UiChannel) {
    world.events.on('removed', obj => { if (this.target === obj) this.close(); });
  }

  open(obj: Obj, x: number, y: number) {
    this.target = obj;
    this.ui.set({ palette: { x, y, c: obj.c } });
    this.viewport.requestDraw();
  }
  close() {
    if (!this.target && !this.ui.state.palette) return;
    this.target = null;
    this.ui.set({ palette: null });
    this.viewport.requestDraw();
  }
  pick(c: number) {
    if (this.target) this.target.c = c;
    this.close();
  }
}
