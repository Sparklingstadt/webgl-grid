import type { AddonModule } from '../engine/addons/Addons';
import cinema4d from './cinema4d';
import float from './float';
import mograph from './mograph';
import mographFields from './mograph-fields';
import mographExtrude from './mograph-extrude';
import mographFracture from './mograph-fracture';
import mographModes from './mograph-modes';
import mographSpline from './mograph-spline';
import mographText from './mograph-text';
import mographTracer from './mograph-tracer';
import scatter from './scatter';
import turntable from './turntable';

// --- 組み込みのアドオン (Cinema 4D と MoGraph は最初から有効、ほかは最初は切ってある。編集 > アドオンマネージャーで切り替える) ---
export const BUILTIN_ADDONS: AddonModule[] = [cinema4d, mograph, mographFields, mographModes, mographFracture, mographExtrude, mographText, mographSpline, mographTracer, turntable, float, scatter];
