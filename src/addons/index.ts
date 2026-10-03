import type { AddonModule } from '../engine/addons/Addons';
import float from './float';
import scatter from './scatter';
import turntable from './turntable';

// --- 組み込みのアドオン (最初は切ってある。編集 > プリファレンス で有効にする) ---
export const BUILTIN_ADDONS: AddonModule[] = [turntable, float, scatter];
