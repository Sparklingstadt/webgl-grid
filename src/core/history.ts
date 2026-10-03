import type { AnimationJson } from './animation';
import { msg } from './i18n';
import type { BoneValue } from './types';

// --- 元に戻す・やり直し: 場面の写し (three.js にも画面にも依存しない形) と、何が変わったかの名前 ---
export interface ObjState {
  id: number; s: number; x: number; y: number; z: number; r: number; c: number;
  slots: (string | null)[];
  data: Record<string, unknown>; // 物ごとの値 (ライト・アドオンのもの)
  // MMD モデルだけ。pose・morphs は、キーやモーションから決まるもの (再生で変わる) を除く
  pose?: [number, BoneValue][];
  morphs?: number[];
  anim?: AnimationJson | null;
  hairHang?: boolean | null;
  ikOff?: number[];       // 切った IK (ターゲットのボーンの番号)
  motion?: string | null; // モーションのファイルの名前 (変わったかを見分けるため)
}
export interface SceneState { objects: ObjState[]; materials: unknown[]; range: [number, number]; data: Record<string, unknown> } // data: 場面の値
// 物ごとの値・場面の値の名前 (key → 「元に戻す: …」の名前)。登録した順に見る
export interface ChangeLabels { objectData: [string, string][]; sceneData: [string, string][] }

// 1 つ前の写しから何が変わったか (「元に戻す: 移動」の名前)。大きな変化を優先する
export function describeChange(prev: SceneState, next: SceneState, labels: ChangeLabels = { objectData: [], sceneData: [] }): string {
  const before = new Map(prev.objects.map(o => [o.id, o]));
  const ids = new Set(next.objects.map(o => o.id));
  if (next.objects.some(o => !before.has(o.id))) return msg('追加');
  if (prev.objects.some(o => !ids.has(o.id))) return msg('削除');
  if (prev.objects.map(o => o.id).join() !== next.objects.map(o => o.id).join()) return msg('並べ替え');
  const pairs = next.objects.map(o => [before.get(o.id)!, o] as const);
  const changed = (k: keyof ObjState) => pairs.some(([a, b]) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  const differ = (a: unknown, b: unknown) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
  if (changed('anim')) return msg('キーフレーム');
  for (const [key, label] of labels.objectData) if (pairs.some(([a, b]) => differ(a.data[key], b.data[key]))) return label;
  if (changed('x') || changed('z')) return msg('移動');
  if (changed('r')) return msg('回転');
  if (changed('c')) return msg('色');
  if (changed('slots') || JSON.stringify(prev.materials) !== JSON.stringify(next.materials)) return msg('マテリアル');
  if (changed('pose')) return msg('ポーズ');
  if (changed('morphs')) return msg('表情');
  if (changed('hairHang')) return msg('髪を重力で垂らす');
  if (changed('ikOff')) return msg('IK');
  if (changed('motion')) return msg('モーション');
  if (prev.range.join() !== next.range.join()) return msg('フレーム範囲');
  for (const [key, label] of labels.sceneData) if (differ(prev.data[key], next.data[key])) return label;
  return msg('変更');
}
