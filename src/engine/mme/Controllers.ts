import * as THREE from 'three';
import { MMD_UNITS } from '../../core/constants';
import { t } from '../../core/i18n';
import { controlRefs, virtualControls, type ControlRef } from '../../core/mme/controllers.ts';
import { toMmd, toMmdVec } from '../../core/mme/coords.ts';
import { isModel, type Obj } from '../types';
import type { World } from '../world/World';
import { objectName, pmxName, STAGE, type Owner } from './Assignments';
import type { LoadedEffect } from './EffectStore';

// --- CONTROLOBJECT の値 (設計書「CONTROLOBJECT」): 場面の物 ((self)・(OffscreenOwner)・名前が合う物) の値。
// ray_controller.pmx などの「仮のコントローラー」は、場面に置いたコントローラーの物 (Obj.mmeObj) で、値はその物の mmeValues ---

export interface ControllersDeps {
  world: World;
  stage: () => THREE.Object3D | null; // ステージ (MMD モデル。場面の物に合う名前がないときに .pmx のファイル名で引く)
  warn: (message: string) => void;
  outputting?: () => boolean; // 書き出し中 (書き出しで隠す物は隠れているものとして読む)
}

// 値を読む相手: 位置と行列を持つ node と、MMD モデルならその SkinnedMesh (モーフと骨)
interface Target { node: THREE.Object3D; mesh: THREE.SkinnedMesh | null; visible: boolean }

// アクセサリの項目 (MMD のアクセサリの座標・回転・大きさ・透明度)。対応しない
const ACCESSORY_ITEMS = new Set(['X', 'Y', 'Z', 'XYZ', 'Rx', 'Ry', 'Rz', 'Rxyz', 'Si', 'Tr']);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function visibleChain(o: THREE.Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}

const UNITS = new THREE.Matrix4().makeScale(MMD_UNITS, MMD_UNITS, MMD_UNITS);

// ワールド行列の位置を MME の空間 (MMD の単位・左手系) で (float3 は先の 3 つ、float4 は呼ぶ側 (semantics) が足りない成分を 1 にする)
function positionOf(m: THREE.Matrix4): number[] {
  return toMmdVec(new THREE.Vector3().setFromMatrixPosition(m).multiplyScalar(MMD_UNITS)).toArray();
}

// 型に合わせた、行列か位置の値 (float・bool は行列も位置もないので null)。行列は MME の空間: toMmd(Scale(MMD_UNITS) · m)
function spatial(m: THREE.Matrix4, type: ControlRef['type']): number[] | null {
  if (type === 'float4x4') return toMmd(new THREE.Matrix4().multiplyMatrices(UNITS, m)).elements.slice();
  return type === 'float3' || type === 'float4' ? positionOf(m) : null;
}

const isController = (o: Owner): o is Obj => !!o && o !== STAGE && o.mmeObj?.kind === 'controller';

// 仮のコントローラーの項目の値を型に合わせる (float はそのまま、bool は 0 より大きければ 1。項目のないもの・ほかの型は null)
function itemValue(v: number, ref: ControlRef): number[] | null {
  if (ref.item === null) return null;
  if (ref.type === 'float') return [v];
  return ref.type === 'bool' ? [v > 0 ? 1 : 0] : null;
}

export class Controllers {
  private warned = new Set<string>();
  private stageFound: { root: THREE.Object3D; mesh: THREE.SkinnedMesh | null } | null = null;

  constructor(private d: ControllersDeps) {}

  // CONTROLOBJECT の値 (型の形に合わない分は呼ぶ側 (semantics) が合わせる)。null は 0。
  // self: いま描いている物 (ステージは STAGE、ポストエフェクトは null)、owner: オフスクリーンの持ち主 (同じ。なければ null)。
  // 名前が合う物がなければ、置いていない仮のコントローラーとして 0
  value(ref: ControlRef, self: Owner, owner: Owner): number[] | null {
    const n = ref.name.toLowerCase();
    if (n === '(self)') return this.readOwner(self, ref);
    if (n === '(offscreenowner)') return this.readOwner(owner, ref);
    const found = this.find(ref.name);
    return found ? this.readOwner(found, ref) : itemValue(0, ref);
  }

  // 名前 (大文字小文字を問わない) が合う最初の物 (場面の並び) が、コントローラーの物ならそれ (CONTROLOBJECT が読む物)
  controller(name: string): Obj | null {
    const found = this.find(name);
    return isController(found) ? found : null;
  }

  // 名前が合う物 (場面の物かステージ) がある
  has(name: string): boolean {
    return this.find(name) !== null;
  }

  // 描いているエフェクトの項目から、仮のコントローラーの名前ごとの、スライダーにできる項目 (画面のスライダーの元)。
  // 場面にない名前と、コントローラーの物がある名前 (ほかの物・ステージに合う名前は載せない)
  catalog(effects: LoadedEffect[]): Map<string, string[]> {
    const refs = effects.flatMap(e => (e.result.ok ? controlRefs(e.result.effect) : []));
    return virtualControls(refs, name => {
      const found = this.find(name);
      return found !== null && !isController(found);
    });
  }

  // 出した警告を忘れる (描くときの警告を捨てたあと、また出す)
  clearWarnings(): void {
    this.warned.clear();
  }

  // コントローラーの物は mmeValues の項目、ほかの物・ステージはモーフ・骨・行列
  private readOwner(o: Owner, ref: ControlRef): number[] | null {
    if (isController(o)) return itemValue(ref.item === null ? 0 : o.mmeValues?.[ref.item] ?? 0, ref);
    return this.read(this.ofOwner(o), ref);
  }

  private ofOwner(o: Owner): Target | null {
    return o === STAGE ? this.ofStage() : o && this.ofObj(o);
  }

  private ofObj(obj: Obj): Target {
    const hidden = this.d.outputting?.() ? obj.hideRender : obj.hidden || obj.colHidden;
    return {
      node: isModel(obj) ? obj.model : obj.node,
      mesh: isModel(obj) ? obj.model : null,
      visible: !hidden && visibleChain(obj.node),
    };
  }

  // 名前が合う最初の物 (置いた物が場面の並びで先、なければステージ)
  private find(name: string): Obj | typeof STAGE | null {
    for (const obj of this.d.world.objects) if (same(objectName(obj), name)) return obj;
    const target = this.ofStage();
    const file = target && pmxName(target.mesh!);
    return target && file && same(file, name) ? STAGE : null;
  }

  // ステージのモデル (なければ・まだ読み込み中なら null)
  private ofStage(): Target | null {
    const stage = this.d.stage();
    const found = stage && this.stageMesh(stage);
    return stage && found ? { node: found, mesh: found, visible: visibleChain(stage) } : null;
  }

  // ステージの中のモデル (最初の SkinnedMesh)。見つかったら、ステージが替わるまで探し直さない (uniform ごとに引くので)
  private stageMesh(stage: THREE.Object3D): THREE.SkinnedMesh | null {
    if (this.stageFound?.root !== stage || !this.stageFound.mesh) { // (まだ読み込み中で見つからないあいだは探し直す)
      let mesh: THREE.SkinnedMesh | null = null;
      stage.traverse(o => { if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh; });
      this.stageFound = { root: stage, mesh };
    }
    return this.stageFound.mesh;
  }

  private read(target: Target | null, ref: ControlRef): number[] | null {
    if (!target) return null;
    const { item, type } = ref;
    if (item === null) return type === 'bool' ? [target.visible ? 1 : 0] : spatial(target.node.matrixWorld, type);
    const { mesh } = target;
    const bone = mesh?.skeleton?.bones.find(b => b.name === item);
    if (bone) return spatial(bone.matrixWorld, type);
    const morph = mesh?.morphTargetDictionary?.[item];
    if (morph !== undefined) return type === 'float' ? [mesh!.morphTargetInfluences?.[morph] ?? 0] : null;
    if (ACCESSORY_ITEMS.has(item) && !this.warned.has(item)) {
      this.warned.add(item);
      this.d.warn(t('CONTROLOBJECT の項目 {item} (アクセサリの値) には対応していないので、0 を渡します', { item }));
    }
    return null;
  }
}
