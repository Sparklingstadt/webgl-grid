import type { AddonModule } from '../engine/addons/Addons';
import cinema4d from './cinema4d';
import float from './float';
import mograph from './mograph';
import mographFields from './mograph-fields';
import mographModes from './mograph-modes';
import scatter from './scatter';
import turntable from './turntable';

// --- 組み込みのアドオン (Cinema 4D と MoGraph は最初から有効、ほかは最初は切ってある。編集 > アドオンマネージャーで切り替える) ---
export const BUILTIN_ADDONS: AddonModule[] = [cinema4d, mograph, mographFields, mographModes, turntable, float, scatter];
