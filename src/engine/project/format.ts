import { strFromU8, strToU8, unzip, zip, type AsyncZippable } from 'fflate';
import type { AnimationJson } from '../../core/animation';
import type { ClonerSettings } from '../../core/cloner';
import type { Deformer } from '../../core/deform';
import type { LightSettings } from '../../core/light';
import type { NodeTree } from '../../core/materials/tree';
import type { OutputSettings } from '../../core/output';
import type { SceneSettings } from '../../core/scene';
import type { BoneValue } from '../../core/types';
import type { MaterialOutline, MaterialSettings, MmdSource } from '../materials/MaterialLibrary';

// --- プロジェクトの保存と読み込み ---
// 2 つの形式がある。中身 (project.json: 場面の状態) は同じで、読み込んだファイル (モデル・テクスチャ・モーション・曲) の持ち方が違う
//   .wgp  … ZIP。ファイルそのもの (assets/) も入れる。これだけで同じ場面を開き直せる
//   .wgpj … JSON だけ。ファイルは名前・大きさ (と分かれば元のパス) で参照するだけなので小さい。
//            開くときに、参照しているファイルを探す (同じページで読んだもの → 選んでもらう)
export const PROJECT_FORMAT = 'webgl-grid-project';
export const PROJECT_VERSION = 2; // 2: キーフレームをチャンネルごとに
export type ProjectStorage = 'embedded' | 'reference';
export const PROJECT_EXT: Record<ProjectStorage, string> = { embedded: 'wgp', reference: 'wgpj' };

export type Pose = [number, BoneValue][];
// path: ZIP の中の場所 (.wgp)。source: 元のファイルの場所 (MCP で読んだときなど、分かるときだけ)。
// relative: プロジェクトのファイルから見た元のファイルの場所 (MCP サーバーが保存するときに付ける)
export interface SavedAsset { id: string; name: string; type: string; size?: number; path?: string; source?: string; relative?: string }
// 参照だけのプロジェクトを開くとき、見つからないファイルを探してもらう。
// 選ばれたファイル / 'skip' (見つかったものだけで開く) / 'cancel' (開くのをやめる)
export type PickMissing = (missing: SavedAsset[]) => Promise<File[] | 'skip' | 'cancel'>;
export class ProjectCancelled extends Error { constructor() { super('開くのをやめました'); } }
export interface SavedObject {
  kind: 'shape' | 'model' | 'light';
  s: number; x: number; y: number; z: number; r: number; c: number;
  slots: (string | null)[];
  activeSlot?: number;
  cloner?: ClonerSettings | null; // クローナー
  deformers?: Deformer[] | null;  // デフォーマ
  light?: LightSettings | null;   // ライト
  // MMD モデルだけ
  files?: string[];
  pose?: Pose;
  morphs?: number[] | null;
  anim?: AnimationJson | null; // キーフレーム (チャンネルごと。版 2 から)
  keys?: [number, { pose: Pose; morphs: number[] | null }][]; // 版 1 のキーフレーム (フレームごとのポーズ全体。開くときに変換する)
  hairHang?: boolean;
  motion?: string | null;
  boneSel?: number;
}
export interface SavedImage {
  id: string;
  name: string;
  from: { object: number | 'stage'; index: number } | { asset: string; flipY: boolean };
}
export interface SavedMaterial { id: string; name: string; tree: NodeTree; settings: MaterialSettings; outline: MaterialOutline; mmd?: MmdSource }
export interface ProjectData {
  format: typeof PROJECT_FORMAT;
  version: number;
  storage?: ProjectStorage; // なければ embedded
  assets: SavedAsset[];
  objects: SavedObject[];
  stage: { files: string[] } | null;
  materials: SavedMaterial[];
  images: SavedImage[];
  camera: { yaw: number; pitch: number; dist: number; tx: number; ty: number; tz: number; fov: number; mode: 'orbit' | 'pan'; viewName: string };
  cameraMotion: string | null;
  music: string | null;
  timeline: { start: number; end: number; frame: number };
  selected: number | null;
  output?: OutputSettings; // 出力 (レンダリングの大きさ・形式)。古いプロジェクトにはない
  scene?: SceneSettings;   // シーンの設定 (空・床・太陽)。古いプロジェクトにはない
}

export const projectBaseName = (name: string) => name.replace(/\.wgpj?$/i, '');

export function parseData(json: string): ProjectData {
  let data: ProjectData;
  try { data = JSON.parse(json); } catch { throw new Error('プロジェクトのファイルではありません'); }
  if (data?.format !== PROJECT_FORMAT) throw new Error('プロジェクトのファイルではありません');
  if (data.version > PROJECT_VERSION) throw new Error('このプロジェクトは新しい版で保存されています');
  return data;
}
// .wgp: ZIP の中のファイルを取り出す
export async function readEmbedded(bytes: Uint8Array) {
  let entries: Record<string, Uint8Array>;
  try { entries = await unzipAsync(bytes); } catch { throw new Error('プロジェクトのファイル (.wgp / .wgpj) ではありません'); }
  const json = entries['project.json'];
  if (!json) throw new Error('プロジェクトのファイル (.wgp) ではありません (project.json がありません)');
  const data = parseData(strFromU8(json));
  const files = new Map<string, File>();
  for (const a of data.assets) {
    const body = a.path ? entries[a.path] : undefined;
    if (!body) continue;
    const f = new File([body as BlobPart], a.name, { type: a.type });
    if (a.source) Object.defineProperty(f, 'sourcePath', { value: a.source }); // 元の場所を引き継ぐ (参照だけで保存し直すとき)
    files.set(a.id, f);
  }
  return { data, files };
}

const zipAsync = (files: AsyncZippable) => new Promise<Uint8Array>((ok, ng) => zip(files, { level: 6 }, (err, data) => (err ? ng(err) : ok(data))));
const unzipAsync = (data: Uint8Array) => new Promise<Record<string, Uint8Array>>((ok, ng) => unzip(data, (err, files) => (err ? ng(err) : ok(files))));
// 画像・曲はもう圧縮されているので、縮めずにそのまま入れる (速い)
const STORED = /\.(png|jpe?g|gif|webp|mp3|m4a|aac|ogg|oga|opus|flac)$/i;

// .wgpj: JSON だけ
export const writeReference = (data: ProjectData) => strToU8(JSON.stringify(data, null, 1));
// .wgp: project.json と、ファイルそのもの (assets/)
export async function writeEmbedded(data: ProjectData, assets: Map<File, SavedAsset>) {
  const files: AsyncZippable = { 'project.json': strToU8(JSON.stringify(data, null, 1)) };
  for (const [f, a] of assets) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    files[a.path!] = STORED.test(f.name) ? [bytes, { level: 0 }] : bytes;
  }
  return zipAsync(files);
}
