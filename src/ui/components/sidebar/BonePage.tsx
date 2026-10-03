import { useMemo } from 'react';
import { msg, t } from '../../../core/i18n';
import type { BoneValue } from '../../../core/types';
import { BONE_MOVE, BONE_ROTATE } from '../../../engine';
import { useEngine, useUi } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { BCheck } from '../controls/BCheck';
import { BSelect } from '../controls/BSelect';
import { CurveEditor } from '../CurveEditor';
import { Empty, NeedModel, Panel } from './Panel';

// --- ボーン ---
const ROT_ROWS: [keyof BoneValue, string][] = [['rx', msg('回転 X')], ['ry', msg('回転 Y')], ['rz', msg('回転 Z')]];
const MOVE_ROWS: [keyof BoneValue, string][] = [['px', msg('位置 X')], ['py', msg('位置 Y')], ['pz', msg('位置 Z')]];
export function BonePage({ onLoadPose }: { onLoadPose: () => void }) {
  return <NeedModel>{id => <BoneEditor key={id} onLoadPose={onLoadPose} />}</NeedModel>;
}
function BoneEditor({ onLoadPose }: { onLoadPose: () => void }) {
  const engine = useEngine();
  const version = useUi(s => s.modelVersion);
  useUi(s => s.values); // 値が変わったら描き直す
  useUi(s => s.keysVersion); // キーフレームの有無で説明が変わる
  const groups = useMemo(() => { void version; return engine.boneGroups(); }, [engine, version]);
  const sel = engine.boneSel();
  const flags = sel === undefined ? 0 : engine.boneFlags(sel);
  const v = sel === undefined ? null : engine.boneValue(sel);
  const frame = useUi(s => s.frame);
  const curve = sel === undefined ? null : engine.keyCurve({ kind: 'bone', index: sel });
  return (
    <>
      <Panel title={t('ボーン')}>
        {sel === undefined || !v ? <Empty>{t('手で動かせるボーンがありません')}</Empty> : (
          <>
            <BSelect label={t('動かすボーン')} value={sel} onChange={v => engine.setBoneSel(v)}
                     options={groups.map(g => ({ group: g.label, options: g.bones.map(b => ({ value: b.index, label: b.name })) }))} />
            <div className="note">{t(engine.boneNote(sel))}</div>
            {(flags & BONE_ROTATE) !== 0 && ROT_ROWS.map(([k, label]) => (
              <BSlider key={k} label={t(label)} value={v[k]} min={-180} max={180} step={1} digits={0} unit="°" onChange={x => engine.setBone(sel, k, x)} />
            ))}
            {(flags & BONE_MOVE) !== 0 && MOVE_ROWS.map(([k, label]) => (
              <BSlider key={k} label={t(label)} value={v[k]} min={-20} max={20} step={0.1} digits={1} onChange={x => engine.setBone(sel, k, x)} />
            ))}
          </>
        )}
        <div className="row">
          {sel !== undefined && (
            <button type="button" className="bbtn" onClick={() => engine.insertBoneKey(sel)} title={t('このボーンだけに、いまのフレームのキーを打つ')} aria-label={t('◆ このボーンにキー')}>{t('◆ このボーン')}</button>
          )}
          <button type="button" className="bbtn" onClick={() => engine.resetPose()}>{t('ポーズを戻す')}</button>
        </div>
      </Panel>
      {sel !== undefined && (
        <Panel title={t('補間曲線')}>
          {curve ? (
            <>
              <div className="note">{t('フレーム {frame} のキーへの、前のキーからの進み方 (回転と位置)', { frame })}</div>
              <CurveEditor label={t('補間曲線')} curve={curve} onChange={c => engine.setKeyCurve({ kind: 'bone', index: sel }, c)} />
              <button type="button" className="bbtn" onClick={() => engine.deleteKeyHere({ kind: 'bone', index: sel })}>{t('このキーを消す')}</button>
            </>
          ) : <Empty>{t('このボーンには、フレーム {frame} のキーがありません。タイムラインの「チャンネル」で ◆ を押すと、そのキーへ移ります', { frame })}</Empty>}
        </Panel>
      )}
      <IkPanel />
      <Panel title={t('ポーズファイル (.vpd)')}>
        <div className="row">
          <button type="button" className="bbtn" onClick={() => engine.savePose()}>{t('保存')}</button>
          <button type="button" className="bbtn" onClick={onLoadPose}>{t('読み込む…')}</button>
        </div>
      </Panel>
    </>
  );
}

// IK (オン・オフ)。オフにすると、つながった骨 (足など) を FK で直接回せる
function IkPanel() {
  const engine = useEngine();
  useUi(s => s.values);
  const poseMode = useUi(s => s.poseMode);
  const iks = engine.iks();
  return (
    <Panel title="IK">
      {!iks.length ? <Empty>{t('このモデルには IK がありません')}</Empty> : iks.map(ik => (
        <BCheck key={ik.target} checked={ik.enabled} onChange={on => engine.setIkEnabled(ik.target, on)}>{ik.name}</BCheck>
      ))}
      <div className="note">{t('オフにすると、IK でつながった骨を FK (回転) で直接動かせます。')}{poseMode ? '' : t('ビューポートで動かすには、ポーズモード (Tab) にします。')}</div>
    </Panel>
  );
}
