import { t } from '../../core/i18n';
import { ACCESSORY_DEFAULTS } from '../../core/mme/accessory';
import { normalizeMmeObj, type MmeObjData } from '../../core/mme/settings.ts';
import type { Obj } from '../types';
import type { World } from './World';

// --- MME の物 (仮のコントローラー・仮のアクセサリ。Obj.mmeObj) ---
// 形のない物。アウトライナーでは、ほかの物と同じく選ぶ・名前を変える・複製・消す・保存・元に戻す・コレクションに入れる。
// どのエンジンでも描かず (node の中は空)、物を積む動き (積み重ねの高さ・足場) にも入らない。
// 値は MME のチャンネル (Obj.mmeValues。キーフレームは anim の mme): アクセサリは X〜Tr を MMD の既定で持ち、
// コントローラーの項目は描いているエフェクトの CONTROLOBJECT から集める (はじめは値なし)
export class MmeObjects {
  constructor(private world: World) {}

  // 置く (名前は data の名前。物の名前と mmeObj の名前はいつも同じ)
  add(data: MmeObjData): Obj {
    const d = normalizeMmeObj(data);
    if (!d) throw new Error(t('MME の物には名前が要ります'));
    const obj = this.world.addMmeObject(d);
    if (d.kind === 'accessory') obj.mmeValues = { ...ACCESSORY_DEFAULTS };
    return obj;
  }
}
