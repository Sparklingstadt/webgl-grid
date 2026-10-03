import * as THREE from 'three';
import { errorText } from '../../core/errors';
import { convertMmdMesh } from '../materials/fromMmd';
import type { MaterialLibrary } from '../materials/MaterialLibrary';
import type { Any } from '../types';
import type { UiChannel } from '../UiChannel';
import { Stage } from './Stage';

// 読み込んだモデル: メッシュ・マテリアルスロット (マテリアルの id)・ステージか
export interface LoadedModel { mesh: Any; slots: string[]; isStage: boolean }

// MMDLoader は大きいので、初めて使うときに読み込む
let mmdLoaderModule: Promise<typeof import('three/examples/jsm/loaders/MMDLoader.js')> | null = null;
export const loadMMDLoader = () => (mmdLoaderModule ??= import('three/examples/jsm/loaders/MMDLoader.js'));

// ファイル名の比較用: パスの区切りをそろえ、最後の名前だけを小文字・NFC で取り出す
const fileKey = (path: string) => decodeURIComponent(path).replace(/\\/g, '/').split('/').pop()!.normalize('NFC').toLowerCase();

// --- MMD モデル (.pmx) をメッシュにする ---
// .pmx とテクスチャ画像をまとめて選んでもらい、ブラウザの中だけで読む (どこにも送らない)。
// 材質はプリンシプル BSDF のマテリアルに変換する。置く場所 (人物かステージか) は呼ぶ側が決める
export class MmdLoader {
  constructor(private ui: UiChannel, private library: MaterialLibrary, private onProgress: () => void) {}

  async load(files: File[]): Promise<LoadedModel | null> {
    const mesh = await this.loadMesh(files);
    if (!mesh) return null;
    const slots = convertMmdMesh(mesh, this.library);
    return { mesh, slots, isStage: Stage.isStage(mesh, mesh.userData.fileName) };
  }

  private async loadMesh(files: File[]): Promise<Any | null> {
    const pmx = files.find(f => /\.pmx$/i.test(f.name));
    if (!pmx) { this.ui.toast('.pmx ファイルが選ばれていません。モデルの .pmx とテクスチャ画像をまとめて選んでください。'); return null; }
    this.ui.toast(`${pmx.name} を読み込み中…`, 0);
    const MODEL_URL = '__model__.pmx';
    const byKey = new Map(files.map(f => [fileKey(f.name), f]));
    const urls = new Map(files.map(f => [fileKey(f.name), URL.createObjectURL(f)]));
    const used = new Set<File>([pmx]); // 実際に使ったファイル (プロジェクトに入れる)
    urls.set(MODEL_URL, URL.createObjectURL(pmx));
    const missing = new Set<string>();
    const manager = new THREE.LoadingManager();
    // ローダーが求めるファイル (モデル本体・テクスチャ) を、選ばれたファイルに置き換える
    manager.setURLModifier(url => {
      if (/^(data|blob):/.test(url)) return url;
      const found = urls.get(fileKey(url));
      if (found) {
        const file = byKey.get(fileKey(url));
        if (file) used.add(file);
        return found;
      }
      missing.add(decodeURIComponent(url).replace(/^\.\//, ''));
      return 'data:,'; // 見つからないテクスチャは読まずに飛ばす
    });
    manager.onProgress = this.onProgress;
    manager.onLoad = () => {
      for (const u of urls.values()) URL.revokeObjectURL(u);
      this.onProgress();
      if (missing.size) this.ui.toast(`見つからないテクスチャがあります: ${[...missing].join('、')}`, 8000);
    };
    try {
      const { MMDLoader } = await loadMMDLoader();
      const loader: Any = new MMDLoader(manager);
      // MMDLoader.load() と同じことを 2 段に分けてする。表情 (モーフ) の分類 (眉・目・口・その他) は
      // 組み立てたメッシュには残らないので、組み立てる前の解析結果から拾っておく
      const data: Any = await new Promise((resolve, reject) => loader.loadPMX(MODEL_URL, resolve, undefined, reject));
      const mesh = loader.meshBuilder.build(data, './', undefined, (err: unknown) => console.error(err));
      mesh.userData.morphPanels = new Map(data.morphs.map((m: Any) => [m.name, m.panel]));
      // ボーンを手で動かすための情報: 表示枠 (MMD でボーンを選ぶときのグループ)、フラグ、最初の姿勢
      mesh.userData.boneFrames = (data.frames ?? []).map((f: Any) => ({
        name: f.name, bones: f.elements.filter((e: Any) => e.target === 0).map((e: Any) => e.index),
      })).filter((f: Any) => f.bones.length);
      mesh.userData.boneFlags = data.bones.map((b: Any) => b.flag);
      mesh.userData.rest = mesh.skeleton.bones.map((b: THREE.Bone) => ({ p: b.position.clone(), q: b.quaternion.clone() }));
      mesh.userData.fileName = pmx.name;
      mesh.userData.sourceFile = pmx;    // .pmx に書き出すときの元のファイル
      mesh.userData.usedFiles = used;    // プロジェクトに入れるファイル (テクスチャは読み終わると増える)
      mesh.name ||= data.metadata.modelName || pmx.name.replace(/\.pmx$/i, '');
      fixEmptyMorphs(mesh);
      return mesh;
    } catch (err) {
      console.error(err);
      this.ui.toast(`${pmx.name} を読み込めませんでした: ${errorText(err)}`, 8000);
      return null;
    }
  }
}

// モーフ (表情など) が1つもないモデルでも、MMDLoader は空のモーフ情報を付ける。
// three.js はそれを「モーフあり」として扱い、シェーダーの組み立てに失敗するので取り除く
function fixEmptyMorphs(mesh: THREE.Object3D) {
  mesh.traverse((o: Any) => {
    if (!o.geometry) return;
    const ma = o.geometry.morphAttributes;
    for (const k of Object.keys(ma)) if (!ma[k].length) delete ma[k];
    // (表情の対応表は空のまま残す。消すと、表情の動きを含む .vmd を読むときに MMDLoader が止まる)
    if (o.morphTargetInfluences?.length === 0) { o.morphTargetInfluences = undefined; o.morphTargetDictionary = {}; }
  });
}
