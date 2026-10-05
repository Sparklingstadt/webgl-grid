// MMD のアクセサリ (.x の物) の項目と既定値、MMD の座標でのワールド行列。
// .x の形は読まない。値 (位置・回転・拡大・透明度) だけを持つ。
import { Matrix4 } from 'three';

export const ACCESSORY_ITEMS = ['X', 'Y', 'Z', 'Rx', 'Ry', 'Rz', 'Si', 'Tr'] as const;
export type AccessoryItem = typeof ACCESSORY_ITEMS[number];

// Si (拡大) と Tr (透明度) は 1、ほかは 0
export const ACCESSORY_DEFAULTS: Record<AccessoryItem, number> = { X: 0, Y: 0, Z: 0, Rx: 0, Ry: 0, Rz: 0, Si: 1, Tr: 1 };

const DEG = Math.PI / 180;

// 項目の値 (X〜Z は MMD の単位、Rx〜Rz は度) から、MMD の座標 (左手系) のワールド行列。
// Matrix4.elements は D3D の「行ごとの並び」(coords.ts と同じ)。拡大 Si → 回転 → 位置 X・Y・Z の順で、Tr は入らない。
//
// 回転の順 (出典なし・未確認): MME の資料 (MikuMikuEffect リファレンス「コントロールオブジェクト」の Rx・Ry・Rz) には
// 順番の記述が見つからなかった (資料のページは Google サイトで取得できなかった)。仮に MMD のボーンと同じ、
// D3DXMatrixRotationYawPitchRoll(Ry, Rx, Rz) の順 (行ベクトルで Rz → Rx → Ry、すなわち Y・X・Z のオイラー角) にしている。
// MMD の実物と見比べて合わなければ、ここの 1 行を直す。
export function accessoryMatrix(v: Record<string, number>): Matrix4 {
  const get = (k: AccessoryItem): number => v[k] ?? ACCESSORY_DEFAULTS[k];
  // three.js の makeRotation* の数は、そのまま左手系・列ベクトルの回転行列 (D3DX の行ベクトル版の転置と同じ)
  const rot = new Matrix4().makeRotationY(get('Ry') * DEG)
    .multiply(new Matrix4().makeRotationX(get('Rx') * DEG))
    .multiply(new Matrix4().makeRotationZ(get('Rz') * DEG));
  const si = get('Si');
  return new Matrix4().makeTranslation(get('X'), get('Y'), get('Z'))
    .multiply(rot)
    .multiply(new Matrix4().makeScale(si, si, si));
}

// ポストエフェクトの .fx を当てるアクセサリの名前: .fx のファイル名の拡張子を .x にしたもの (Main/ray.fx → ray.x。
// 拡張子が .fx でなければ .x を足す)。MMD で ray.fx を ray.x に当てるのと同じ
export function accessoryNameFor(fxPath: string): string {
  const file = fxPath.slice(Math.max(fxPath.lastIndexOf('/'), fxPath.lastIndexOf('\\')) + 1);
  return `${file.replace(/\.fx$/i, '')}.x`;
}
