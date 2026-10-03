import { useMemo } from 'react';
import type { BoneValue } from '../../../core/types';
import { BONE_MOVE, BONE_ROTATE } from '../../../engine';
import { useEngine, useUi } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { BSelect } from '../controls/BSelect';
import { Empty, NeedModel, Panel } from './Panel';

// --- ボーン ---
const ROT_ROWS: [keyof BoneValue, string][] = [['rx', '回転 X'], ['ry', '回転 Y'], ['rz', '回転 Z']];
const MOVE_ROWS: [keyof BoneValue, string][] = [['px', '位置 X'], ['py', '位置 Y'], ['pz', '位置 Z']];
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
  return (
    <>
      <Panel title="ボーン">
        {sel === undefined || !v ? <Empty>手で動かせるボーンがありません</Empty> : (
          <>
            <BSelect label="動かすボーン" value={sel} onChange={v => engine.setBoneSel(v)}
                     options={groups.map(g => ({ group: g.label, options: g.bones.map(b => ({ value: b.index, label: b.name })) }))} />
            <div className="note">{engine.boneNote(sel)}</div>
            {(flags & BONE_ROTATE) !== 0 && ROT_ROWS.map(([k, label]) => (
              <BSlider key={k} label={label} value={v[k]} min={-180} max={180} step={1} digits={0} unit="°" onChange={x => engine.setBone(sel, k, x)} />
            ))}
            {(flags & BONE_MOVE) !== 0 && MOVE_ROWS.map(([k, label]) => (
              <BSlider key={k} label={label} value={v[k]} min={-20} max={20} step={0.1} digits={1} onChange={x => engine.setBone(sel, k, x)} />
            ))}
          </>
        )}
        <button type="button" className="bbtn" onClick={() => engine.resetPose()}>ポーズを戻す</button>
      </Panel>
      <Panel title="ポーズファイル (.vpd)">
        <div className="row">
          <button type="button" className="bbtn" onClick={() => engine.savePose()}>保存</button>
          <button type="button" className="bbtn" onClick={onLoadPose}>読み込む…</button>
        </div>
      </Panel>
    </>
  );
}
