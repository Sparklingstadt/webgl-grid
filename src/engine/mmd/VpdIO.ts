import type * as THREE from 'three';
import { encodeShiftJis } from '../../core/sjis';
import type { BoneValue } from '../../core/types';
import { decodeMmdText, formatVpd, parseVpd, type VpdPose } from '../../core/vpdFormat';
import type { Viewport } from '../render/Viewport';
import type { ModelObj } from '../types';
import type { UiChannel } from '../UiChannel';
import type { Posing } from './Posing';

// --- ポーズの保存・読み込み (.vpd) ---
// MMD のポーズファイル。文字コードは Shift-JIS (書式は core/vpdFormat.ts)。
// 保存するのは、手で動かしたボーンと、いまの表情
export class VpdIO {
  constructor(private posing: Posing, private viewport: Viewport, private ui: UiChannel) {}

  save(obj: ModelObj) {
    const mesh = obj.model, bones: THREE.Bone[] = mesh.skeleton.bones;
    const dict: Record<string, number> = mesh.morphTargetDictionary ?? {}, inf: number[] = mesh.morphTargetInfluences ?? [];
    const pose: VpdPose = {
      bones: [...(obj.pose ?? [])].map(([i, value]) => ({ name: bones[i].name, value })),
      morphs: Object.entries(dict).filter(([, i]) => inf[i] > 0).map(([name, i]) => ({ name, weight: inf[i] })),
    };
    const blob = new Blob([encodeShiftJis(formatVpd(mesh.name, pose)) as BlobPart], { type: 'application/octet-stream' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${mesh.name || 'pose'}.vpd` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.ui.toast(`ポーズを ${a.download} として保存しました (ボーン ${pose.bones.length} 本、表情 ${pose.morphs.length} 個)`);
  }

  async load(file: File, objs: ModelObj[]) {
    if (!objs.length) { this.ui.toast('先に .pmx のモデルを読み込んでください。'); return; }
    const pose = parseVpd(decodeMmdText(await file.arrayBuffer()));
    if (!pose) { this.ui.toast(`${file.name} は MMD のポーズファイル (.vpd) ではないようです`, 8000); return; }
    let found = 0;
    for (const obj of objs) {
      const mesh = obj.model, bones: THREE.Bone[] = mesh.skeleton.bones;
      obj.pose = new Map<number, BoneValue>();
      for (const pb of pose.bones) {
        const i = bones.findIndex(b => b.name === pb.name);
        if (i < 0) continue;
        found++;
        obj.pose.set(i, pb.value);
      }
      const dict: Record<string, number> = mesh.morphTargetDictionary ?? {};
      if (mesh.morphTargetInfluences) {
        mesh.morphTargetInfluences.fill(0);
        for (const pm of pose.morphs) if (dict[pm.name] !== undefined) { mesh.morphTargetInfluences[dict[pm.name]] = pm.weight; found++; }
      }
      await this.posing.solve(obj);
    }
    this.ui.bump('values');
    this.viewport.startTicking();
    this.viewport.requestDraw();
    this.ui.toast(found
      ? `${file.name} のポーズを当てました (ボーン ${pose.bones.length} 本・表情 ${pose.morphs.length} 個のうち、合ったもの ${found} 個)`
      : `${file.name} には、このモデルのボーンや表情に合うものがありませんでした`, 6000);
  }
}
