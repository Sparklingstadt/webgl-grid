import * as THREE from 'three';
import { MAX_BOXES, MMD_SCALE } from '../constants';
import { requestDraw } from '../loop';
import { startMusic } from '../music';
import { boxes, dropIn, findFreeSpot, makeNode } from '../objects';
import { selObj, selectObj } from '../selection';
import { radiusOf } from '../stacking';
import type { Any, Obj } from '../types';
import { toast } from '../ui';
import { playMotions } from './motion';
import { startPhysics } from './physics';
import { STAGE, addStage, isStageModel, stageModel } from './stage';
import { loadPose } from './vpd';

// --- MMD モデル (.pmx) とモーション (.vmd)・ポーズ (.vpd)・曲の読み込み ---
// .pmx とテクスチャ画像 (と、あれば .vmd) をまとめて選んでもらい、ブラウザの中だけで読む (どこにも送らない)。
// .vmd だけを選んだときは、置いてあるモデル全員にそのモーションを付ける

// MMDLoader は大きいので、初めて使うときに読み込む
let mmdLoaderModule: Promise<typeof import('three/examples/jsm/loaders/MMDLoader.js')> | null = null;
export const loadMMDLoader = () => (mmdLoaderModule ??= import('three/examples/jsm/loaders/MMDLoader.js'));

const isAudio = (f: File) => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i.test(f.name);
export async function loadFiles(files: File[]) {
  // .vmd は何個でも一緒に選べる (ダンス用とカメラ用など)。曲は 1 つ
  const vmds = files.filter(f => /\.vmd$/i.test(f.name));
  const vpd = files.find(f => /\.vpd$/i.test(f.name));
  const song = files.find(isAudio);
  const hasPmx = files.some(f => /\.pmx$/i.test(f.name));
  let targets: Obj[];
  if (hasPmx) {
    const obj = await loadPmx(files);
    if (!obj) return;
    // ステージを読んだときは、モーションは置いてある人物全員に付ける
    targets = obj === STAGE ? boxes.filter(b => b.s === 3) : [obj];
  } else if (vmds.length || song || vpd) {
    targets = boxes.filter(b => b.s === 3);
  } else {
    toast('.pmx・.vmd・.vpd・曲のどれも選ばれていません。モデルの .pmx とテクスチャ画像、モーションの .vmd、ポーズの .vpd、曲のファイルを選んでください。');
    return;
  }
  // ポーズ (.vpd) は、モデルを選んでいるならそのモデルに、そうでなければ対象のモデル全員に当てる
  if (vpd) await loadPose(vpd, selObj?.s === 3 && !hasPmx ? [selObj] : targets);
  const motionOk = vmds.length ? await playMotions(vmds, targets) : true;
  // モーションの読み込みに失敗したときは、そのお知らせを曲のお知らせで消さない
  if (song) startMusic(song, motionOk);
}

// ファイル名の比較用: パスの区切りをそろえ、最後の名前だけを小文字・NFC で取り出す
const fileKey = (path: string) => decodeURIComponent(path).replace(/\\/g, '/').split('/').pop()!.normalize('NFC').toLowerCase();
async function loadPmx(files: File[]): Promise<Obj | typeof STAGE | undefined> {
  if (boxes.length >= MAX_BOXES) return;
  const pmx = files.find(f => /\.pmx$/i.test(f.name));
  if (!pmx) { toast('.pmx ファイルが選ばれていません。モデルの .pmx とテクスチャ画像をまとめて選んでください。'); return; }
  toast(`${pmx.name} を読み込み中…`, 0);
  const MODEL_URL = '__model__.pmx';
  const urls = new Map(files.map(f => [fileKey(f.name), URL.createObjectURL(f)]));
  urls.set(MODEL_URL, URL.createObjectURL(pmx));
  const missing = new Set<string>();
  const manager = new THREE.LoadingManager();
  // ローダーが求めるファイル (モデル本体・テクスチャ) を、選ばれたファイルに置き換える
  manager.setURLModifier(url => {
    if (/^(data|blob):/.test(url)) return url;
    const found = urls.get(fileKey(url));
    if (found) return found;
    missing.add(decodeURIComponent(url).replace(/^\.\//, ''));
    return 'data:,'; // 見つからないテクスチャは読まずに飛ばす
  });
  manager.onProgress = () => requestDraw();
  manager.onLoad = () => {
    for (const u of urls.values()) URL.revokeObjectURL(u);
    requestDraw();
    if (missing.size) toast(`見つからないテクスチャがあります: ${[...missing].join('、')}`, 8000);
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
    mesh.name ||= data.metadata.modelName || pmx.name.replace(/\.pmx$/i, '');
    fixEmptyMorphs(mesh);
    if (isStageModel(mesh, pmx.name)) {
      addStage(mesh);
      toast(`${pmx.name} をステージとして置きました`);
      return STAGE;
    }
    const obj = addModel(mesh);
    selectObj(obj);
    await startPhysics(obj, mesh);
    toast(`${pmx.name} を置きました`);
    return obj;
  } catch (err: Any) {
    console.error(err);
    toast(`${pmx.name} を読み込めませんでした: ${err?.message ?? err}`, 8000);
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
function addModel(mesh: Any): Obj {
  // MMD_SCALE 倍にして、足元の中心が置き場所に来るようにずらす
  const bbox = new THREE.Box3().setFromObject(mesh);
  const size = bbox.getSize(new THREE.Vector3()), center = bbox.getCenter(new THREE.Vector3());
  const k = MMD_SCALE;
  mesh.scale.setScalar(k);
  mesh.position.set(-center.x * k, -bbox.min.y * k, -center.z * k);
  const base = { x: 0, y: 0, z: 0, c: -1, s: 3, r: 0, py: 0, vy: 0,
                 h: size.y * k, hx: Math.max(size.x * k / 2, 0.05), hz: Math.max(size.z * k / 2, 0.05) };
  // ステージがあるときは、ステージの中心 (MMD で人物が立つ原点) の近くに置く
  [base.x, base.z] = stageModel ? findFreeSpot(radiusOf(base), 0, 0) : findFreeSpot(radiusOf(base));
  const obj = makeNode({ ...base, model: mesh }, mesh);
  // 当たり判定用の複製。置いたモデルはポーズを変えないので、骨やモーフの計算をしない普通のメッシュで判定する
  // (骨で変形するメッシュのまま判定すると、頂点ごとに骨を計算するので 9 万ポリゴンで 1 回 50ms ほどかかる)
  const proxy: Any = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial());
  proxy.morphTargetInfluences = undefined;
  proxy.position.copy(mesh.position);
  proxy.scale.copy(mesh.scale);
  proxy.visible = false;
  proxy.castShadow = false;
  obj.node.add(proxy);
  mesh.traverse((o: Any) => { if (o.isMesh) o.raycast = () => {}; });
  boxes.push(obj);
  dropIn(obj);
  return obj;
}
