import { msg } from '../../core/i18n';
import { normalizeCamera } from '../../core/camera';
import { normalizeLight } from '../../core/light';
import { MME_DEFAULTS, normalizeMme, normalizeObjectEffects } from '../../core/mme/settings.ts';
import { normalizeOutput } from '../../core/output';
import { normalizeScene } from '../../core/scene';
import { normalizeMarkers } from '../anim/Markers';
import type { Engine } from '../Engine';
import { COMMANDS } from '../remote/commands';

// --- 本体の機能を、アドオンと同じ形で登録する ---
export function registerBuiltins(e: Engine) {
  const { objectData, sceneData, commands } = e.addons;
  // 物ごとの値
  // ライトは、ライトの物だけ (なしにはできない)
  objectData.add({ key: 'camera', label: msg('カメラ'), get: o => o.camera, set: (o, v) => { if (v && o.camera) e.cameras.set(o, v); }, normalize: raw => normalizeCamera(raw as never) });
  objectData.add({ key: 'light', label: msg('ライト'), get: o => o.light, set: (o, v) => { if (v && o.light) e.lights.set(o, v); }, normalize: raw => normalizeLight(raw as never) });
  // 名前・表示 (アウトライナー)
  objectData.add({ key: 'name', label: msg('名前'), get: o => o.name ?? null, set: (o, v) => e.renameObj(o, v), normalize: raw => (typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 64) : null) });
  const flag = (raw: unknown) => (raw === true ? true : null);
  objectData.add({ key: 'hidden', label: msg('ビューポートで隠す'), get: o => o.hidden ?? null, set: (o, v) => e.setVisibility(o, { hidden: !!v }), normalize: flag });
  objectData.add({ key: 'hideRender', label: msg('レンダリングに写さない'), get: o => o.hideRender ?? null, set: (o, v) => e.setVisibility(o, { hideRender: !!v }), normalize: flag });
  objectData.add({ key: 'scale', label: msg('大きさ'), get: o => o.scale ?? null, set: (o, v) => e.setScale(o, v ?? 1), normalize: raw => (typeof raw === 'number' && Number.isFinite(raw) && raw !== 1 ? Math.min(Math.max(raw, 0.05), 20) : null) });
  objectData.add({ key: 'collection', label: msg('コレクション'), get: o => o.collection ?? null, set: (o, v) => { o.collection = v ?? undefined; }, normalize: raw => (typeof raw === 'string' && raw ? raw.slice(0, 64) : null) });
  // MME 互換の、物ごと・材質ごとのエフェクトの割り当て
  objectData.add({ key: 'mme', label: msg('MME のエフェクト'), get: o => o.mme ?? null, set: (o, v) => e.mme.setObjectEffects(o, v), normalize: normalizeObjectEffects });
  // 場面の値
  sceneData.add({
    key: 'collections', label: msg('コレクション'), history: true,
    save: () => e.collections.map(c => ({ ...c })),
    load: raw => { e.setCollections(Array.isArray(raw) ? raw.filter(c => c && typeof c.name === 'string').map(c => ({ name: String(c.name).slice(0, 64), hidden: !!c.hidden })) : []); },
    reset: () => { e.collections = []; },
  });
  sceneData.add({
    key: 'scene', label: msg('シーン'), history: true,
    save: () => structuredClone(e.environment.settings), load: raw => e.environment.replace(normalizeScene(raw)), reset: () => e.environment.reset(),
  });
  sceneData.add({
    key: 'markers', label: msg('マーカー'), history: true,
    save: () => e.markers.list.map(m => ({ ...m })), load: raw => e.markers.replace(normalizeMarkers(raw)), reset: () => e.markers.replace([]),
  });
  sceneData.add({ key: 'output', label: msg('出力'), save: () => ({ ...e.output.settings }), load: raw => e.output.set(normalizeOutput(raw)) });
  // レンダーエンジン (標準 / MME 互換) とセルフシャドウ・地面の影。ポストエフェクトの一覧は保存せず、最初の状態に戻す (プロジェクトを開く) と
  // エフェクトの割り当て (場面にある物のものも) を外す
  sceneData.add({
    key: 'mme', label: msg('MME 互換'), save: () => ({ ...e.mme.settings }), load: raw => e.mme.set(normalizeMme(raw)),
    reset: () => { e.mme.clearEffects(); e.mme.set({ ...MME_DEFAULTS }); },
  });
  // 外 (MCP) から使える操作
  for (const [key, run] of Object.entries(COMMANDS)) commands.add({ key, run });
}
