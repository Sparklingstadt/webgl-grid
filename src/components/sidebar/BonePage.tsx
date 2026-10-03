import { useMemo } from 'react';
import {
  BONE_MOVE, BONE_ROTATE, boneNote, getBoneFlags, getBoneGroups, getBoneSel, getBoneValue, resetPose, savePose,
  setBoneSel, setBoneValue, ui, type BoneValue,
} from '../../engine';
import { useStore } from '../../store';
import { BSlider } from '../BSlider';
import { Empty, NeedModel, Panel } from './Panel';

// --- ボーン ---
const ROT_ROWS: [keyof BoneValue, string][] = [['rx', '回転 X'], ['ry', '回転 Y'], ['rz', '回転 Z']];
const MOVE_ROWS: [keyof BoneValue, string][] = [['px', '位置 X'], ['py', '位置 Y'], ['pz', '位置 Z']];
export function BonePage({ onLoadPose }: { onLoadPose: () => void }) {
  return <NeedModel>{id => <BoneEditor key={id} onLoadPose={onLoadPose} />}</NeedModel>;
}
function BoneEditor({ onLoadPose }: { onLoadPose: () => void }) {
  const version = useStore(ui, s => s.modelVersion);
  useStore(ui, s => s.values); // 値が変わったら描き直す
  useStore(ui, s => s.keysVersion); // キーフレームの有無で説明が変わる
  const groups = useMemo(() => { void version; return getBoneGroups(); }, [version]);
  const sel = getBoneSel();
  const flags = sel === undefined ? 0 : getBoneFlags(sel);
  const v = sel === undefined ? null : getBoneValue(sel);
  return (
    <>
      <Panel title="ボーン">
        {sel === undefined || !v ? <Empty>手で動かせるボーンがありません</Empty> : (
          <>
            <select className="bselect" aria-label="動かすボーン" value={sel} onChange={e => setBoneSel(+e.currentTarget.value)}>
              {groups.map(g => (
                <optgroup key={g.label} label={g.label}>
                  {g.bones.map(b => <option key={b.index} value={b.index}>{b.name}</option>)}
                </optgroup>
              ))}
            </select>
            <div className="note">{boneNote(sel)}</div>
            {(flags & BONE_ROTATE) !== 0 && ROT_ROWS.map(([k, label]) => (
              <BSlider key={k} label={label} value={v[k]} min={-180} max={180} step={1} digits={0} unit="°" onChange={x => setBoneValue(sel, k, x)} />
            ))}
            {(flags & BONE_MOVE) !== 0 && MOVE_ROWS.map(([k, label]) => (
              <BSlider key={k} label={label} value={v[k]} min={-20} max={20} step={0.1} digits={1} onChange={x => setBoneValue(sel, k, x)} />
            ))}
          </>
        )}
        <button type="button" className="bbtn" onClick={resetPose}>ポーズを戻す</button>
      </Panel>
      <Panel title="ポーズファイル (.vpd)">
        <div className="row">
          <button type="button" className="bbtn" onClick={savePose}>保存</button>
          <button type="button" className="bbtn" onClick={onLoadPose}>読み込む…</button>
        </div>
      </Panel>
    </>
  );
}
