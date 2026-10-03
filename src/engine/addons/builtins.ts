import { normalizeCloner } from '../../core/cloner';
import { normalizeDeformers } from '../../core/deform';
import { normalizeLight } from '../../core/light';
import { normalizeOutput } from '../../core/output';
import { normalizeScene } from '../../core/scene';
import type { Engine } from '../Engine';
import { COMMANDS } from '../remote/commands';

// --- 本体の機能を、アドオンと同じ形で登録する ---
export function registerBuiltins(e: Engine) {
  const { objectData, sceneData, commands } = e.addons;
  // 物ごとの値 (当てる順: クローナー → デフォーマ → ライト)
  objectData.add({ key: 'cloner', label: 'クローナー', get: o => o.cloner, set: (o, v) => e.cloners.set(o, v), normalize: normalizeCloner as (raw: unknown) => ReturnType<typeof normalizeCloner> });
  objectData.add({ key: 'deformers', label: 'デフォーマ', get: o => o.deformers, set: (o, v) => e.deformers.set(o, v ?? []), normalize: raw => { const l = normalizeDeformers(raw); return l.length ? l : null; } });
  // ライトは、ライトの物だけ (なしにはできない)
  objectData.add({ key: 'light', label: 'ライト', get: o => o.light, set: (o, v) => { if (v && o.light) e.lights.set(o, v); }, normalize: raw => normalizeLight(raw as never) });
  // 場面の値
  sceneData.add({
    key: 'scene', label: 'シーン', history: true,
    save: () => structuredClone(e.environment.settings), load: raw => e.environment.replace(normalizeScene(raw)), reset: () => e.environment.reset(),
  });
  sceneData.add({ key: 'output', label: '出力', save: () => ({ ...e.output.settings }), load: raw => e.output.set(normalizeOutput(raw)) });
  // 外 (MCP) から使える操作
  for (const [key, run] of Object.entries(COMMANDS)) commands.add({ key, run });
}
