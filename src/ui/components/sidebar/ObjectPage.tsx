import { PALETTE, PALETTE_NAMES, paletteCss } from '../../../core/constants';
import { useEngine, useUi } from '../../EngineContext';
import { BCheck } from '../controls/BCheck';
import { NumField } from '../NumField';
import { Empty, Panel } from './Panel';

// --- オブジェクト: 選んでいる物の名前・位置・向き・色 ---
export function ObjectPage() {
  const engine = useEngine();
  const sel = useUi(s => s.sel);
  const hairHang = useUi(s => s.hairHang);
  if (!sel) return <Panel title="オブジェクト"><Empty>何も選んでいません。ビューポートで物をクリックすると選べます。</Empty></Panel>;
  const deg = ((sel.r * 180 / Math.PI) % 360 + 540) % 360 - 180;
  return (
    <>
      <Panel title="オブジェクト">
        <div className="prop">
          <label>名前</label><span>{sel.name}</span>
          <label htmlFor="obj-x">位置 X</label><NumField id="obj-x" label="位置 X" value={+sel.x.toFixed(2)} digits={2} step={0.1} onCommit={v => engine.setObjProp('x', v)} />
          <label>位置 Y</label><span className="note">{sel.y.toFixed(2)} (積み重ねで決まる)</span>
          <label htmlFor="obj-z">位置 Z</label><NumField id="obj-z" label="位置 Z" value={+sel.z.toFixed(2)} digits={2} step={0.1} onCommit={v => engine.setObjProp('z', v)} />
          <label htmlFor="obj-r">回転</label><NumField id="obj-r" label="縦軸まわりの回転 (度)" value={Math.round(deg)} onCommit={v => engine.setObjProp('r', v)} />
        </div>
      </Panel>
      {sel.kind === 'shape' && (
        <Panel title="色">
          <div className="swatches" role="group" aria-label="色">
            {PALETTE.map((_, i) => (
              <button key={i} type="button" aria-label={PALETTE_NAMES[i]} title={PALETTE_NAMES[i]} aria-pressed={sel.c === i}
                      style={{ background: paletteCss(i) }} onClick={() => engine.setObjColor(i)} />
            ))}
          </div>
        </Panel>
      )}
      {sel.kind === 'model' && hairHang !== null && (
        <Panel title="物理演算">
          <BCheck checked={hairHang} onChange={on => engine.setHairHang(on)}>髪を重力で垂らす</BCheck>
          <div className="note">髪の形を保つ「錘」の剛体を外して、髪をまっすぐ垂らします。オフにすると、モデルの作者が作った髪の形 (MMD と同じ) に戻ります</div>
        </Panel>
      )}
      {sel.kind === 'model' && (
        <Panel title="モーション">
          <div className="note">{sel.animated ? 'VMD モーションを再生中です。タイムラインで動かせます。' : 'モーションはありません。ファイル > MMD を読み込む… で .vmd を選ぶと付きます。'}</div>
        </Panel>
      )}
      <button type="button" className="bbtn" onClick={() => engine.deleteSelected()}>削除 (X)</button>
    </>
  );
}
