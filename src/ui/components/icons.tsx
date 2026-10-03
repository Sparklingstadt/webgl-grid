import type { ReactNode } from 'react';

// --- Blender 風のアイコン (プロパティのタブ・エディターの種類)。色は Blender の標準テーマに合わせる ---
const ICONS: Record<string, ReactNode> = {
  // レンダー (カメラの背面)
  render: <><rect x="2.5" y="4.5" width="11" height="8" rx="1.5" stroke="#b9b9b9" /><circle cx="8" cy="8.5" r="2.2" stroke="#b9b9b9" /><path d="M5.5 4.5 6.5 3h3l1 1.5" stroke="#b9b9b9" /></>,
  // 出力 (プリンター)
  output: <><path d="M4.5 6V2.5h7V6" stroke="#b9b9b9" /><rect x="2.5" y="6" width="11" height="5" rx="1" stroke="#b9b9b9" /><path d="M4.5 10h7v3.5h-7z" stroke="#b9b9b9" /></>,
  // ワールド (シーンの空・床・太陽)
  world: <><circle cx="8" cy="8" r="5.5" stroke="#e05e5e" /><path d="M2.5 8h11M8 2.5c-2.2 2.5-2.2 8.5 0 11M8 2.5c2.2 2.5 2.2 8.5 0 11" stroke="#e05e5e" /></>,
  // オブジェクト (オレンジの四角)
  object: <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="#f0a040" stroke="#f0a040" />,
  // モディファイアー (青いスパナ)
  modifier: <path d="M10.5 2.5a3 3 0 0 0-2.8 4L3 11.2a1.2 1.2 0 0 0 1.8 1.8l4.7-4.7a3 3 0 0 0 4-2.8l-1.8 1.2-1.6-.4-.4-1.6z" stroke="#6ea6f0" strokeLinejoin="round" />,
  // 物理演算 (青い軌道)
  physics: <><circle cx="8" cy="8" r="2" fill="#6ea6f0" stroke="#6ea6f0" /><ellipse cx="8" cy="8" rx="6" ry="2.6" stroke="#6ea6f0" transform="rotate(-30 8 8)" /></>,
  // シェイプキー・メッシュのデータ (緑の三角)
  shapekey: <path d="M8 2.5 13.5 12.5h-11z" stroke="#7fcf7f" strokeLinejoin="round" />,
  // ボーン (緑)
  bone: <path d="M8 2 11 6 8 14 5 6zM5 6h6" stroke="#7fcf7f" strokeLinejoin="round" />,
  // ライトのデータ (緑の電球)
  light: <><path d="M5.5 9.5a4 4 0 1 1 5 0c-.6.5-.9 1.2-.9 2h-3.2c0-.8-.3-1.5-.9-2z" stroke="#7fcf7f" /><path d="M6.5 14h3" stroke="#7fcf7f" /></>,
  // カメラのデータ (緑のカメラ)
  cameraData: <path d="M2.5 5h7.5v6H2.5z M10 7.5 13.5 5v6L10 8.5" stroke="#7fcf7f" strokeLinejoin="round" />,
  // マテリアル (赤い球)
  material: <><circle cx="8" cy="8" r="5.5" fill="#c0505a" stroke="#e07080" /><circle cx="6.3" cy="6.3" r="1.4" fill="#f3b0b8" stroke="none" /></>,
  // アドオンが足したタブ (パズル)
  addon: <path d="M3 5h2.5a1.5 1.5 0 1 1 3 0H11v2.5a1.5 1.5 0 1 1 0 3V13H8.5a1.5 1.5 0 1 0-3 0H3z" stroke="#b9b9b9" strokeLinejoin="round" />,
  // エディターの種類: アウトライナー・プロパティ・3D ビューポート
  outliner: <path d="M3 4h10M5 8h8M5 12h8M3 4v8" stroke="#c8c8c8" />,
  properties: <><rect x="3" y="2.5" width="10" height="11" rx="1" stroke="#c8c8c8" /><path d="M5 6h6M5 9h6M5 12h3" stroke="#c8c8c8" /></>,
  view3d: <path d="M8 1.5 14 5v6l-6 3.5L2 11V5zM8 1.5v6.5M2 5l6 3 6-3" stroke="#c8c8c8" strokeLinejoin="round" />,
  // 状態バーのマウス
  mouseLeft: <><rect x="4.5" y="2" width="7" height="12" rx="3.5" stroke="#c8c8c8" /><path d="M4.5 6.5h3.5V2.2A3.5 3.5 0 0 0 4.5 5.5z" fill="#c8c8c8" stroke="none" /></>,
  mouseMiddle: <><rect x="4.5" y="2" width="7" height="12" rx="3.5" stroke="#c8c8c8" /><path d="M8 3.5v3" stroke="#c8c8c8" strokeWidth="2" strokeLinecap="round" /></>,
  mouseRight: <><rect x="4.5" y="2" width="7" height="12" rx="3.5" stroke="#c8c8c8" /><path d="M11.5 6.5H8V2.2a3.5 3.5 0 0 1 3.5 3.3z" fill="#c8c8c8" stroke="none" /></>,
};
export type IconName = keyof typeof ICONS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <svg className={`icon ${className ?? ''}`} viewBox="0 0 16 16" fill="none" strokeWidth="1.2" aria-hidden="true">{ICONS[name] ?? ICONS.addon}</svg>;
}
