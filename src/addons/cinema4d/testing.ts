import { BUILTIN_ADDONS } from '..';
import { memoryAddonStorage } from '../../engine/addons/Addons';
import type { Cinema4d } from './Cinema4d';
import { engineWithCube } from '../../engine/testEngine';

// テスト用: 組み込みのアドオンを始めたエンジン (Cinema 4D は最初から有効) と、その窓口
export async function engineWithC4d() {
  const e = engineWithCube();
  await e.addons.start(BUILTIN_ADDONS, memoryAddonStorage());
  return { e, c4d: e.addons.exposed<Cinema4d>('cinema4d')! };
}
