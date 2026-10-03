import { FPS } from '../../../core/constants';
import { RESOLUTION_PRESETS, VIDEO_FORMATS, VIDEO_QUALITIES, frameSpan, presetIndex, type VideoFormat, type VideoQuality } from '../../../core/output';
import { useEngine, useUi } from '../../EngineContext';
import { NumField } from '../NumField';
import { Panel } from './Panel';

// --- 出力 (Blender の出力プロパティ): レンダリングする画像・動画の大きさ・範囲・形式 ---
export function OutputPage() {
  const engine = useEngine();
  const o = useUi(s => s.output);
  const start = useUi(s => s.start);
  const end = useUi(s => s.end);
  const busy = useUi(s => !!s.rendering);
  const hasMusic = !!engine.music.file;
  const preset = presetIndex(o.width, o.height);
  const span = frameSpan(start, end);
  return (
    <>
      <Panel title="解像度">
        <div className="prop">
          <label htmlFor="out-preset">プリセット</label>
          <select id="out-preset" className="bselect" aria-label="解像度のプリセット" value={preset}
                  onChange={e => { const p = RESOLUTION_PRESETS[+e.currentTarget.value]; if (p) engine.setOutput({ width: p.width, height: p.height }); }}>
            {RESOLUTION_PRESETS.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
            {preset < 0 && <option value={-1}>カスタム</option>}
          </select>
          <label htmlFor="out-w">解像度 X</label>
          <NumField id="out-w" label="解像度 X" value={o.width} min={16} step={2} onCommit={v => engine.setOutput({ width: v })} />
          <label htmlFor="out-h">Y</label>
          <NumField id="out-h" label="解像度 Y" value={o.height} min={16} step={2} onCommit={v => engine.setOutput({ height: v })} />
        </div>
        <div className="note">いまの視点から、この大きさで描きます。縦の見える範囲はビューポートと同じで、縦横比が違うと横の範囲が変わります。地面のグリッドと選択の輪郭線は描きません</div>
      </Panel>
      <Panel title="フレーム範囲">
        <div className="prop">
          <label htmlFor="out-start">開始</label>
          <NumField id="out-start" label="レンダリングの開始フレーム" value={start} min={0} onCommit={v => engine.clock.setRange(v, end)} />
          <label htmlFor="out-end">終了</label>
          <NumField id="out-end" label="レンダリングの終了フレーム" value={end} min={0} onCommit={v => engine.clock.setRange(start, v)} />
          <label>長さ</label>
          <span className="note">{span.count} フレーム ({span.seconds.toFixed(1)} 秒・{FPS} fps)</span>
        </div>
      </Panel>
      <Panel title="動画">
        <div className="prop">
          <label htmlFor="out-format">形式</label>
          <select id="out-format" className="bselect" aria-label="動画の形式" value={o.format}
                  onChange={e => engine.setOutput({ format: e.currentTarget.value as VideoFormat })}>
            {VIDEO_FORMATS.map(f => <option key={f.key} value={f.key}>{f.name}</option>)}
          </select>
          <label htmlFor="out-quality">画質</label>
          <select id="out-quality" className="bselect" aria-label="動画の画質" value={o.quality}
                  onChange={e => engine.setOutput({ quality: e.currentTarget.value as VideoQuality })}>
            {VIDEO_QUALITIES.map(q => <option key={q.key} value={q.key}>{q.name}</option>)}
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={o.audio} onChange={e => engine.setOutput({ audio: e.currentTarget.checked })} />
          曲を入れる{hasMusic ? '' : ' (曲を読み込んでいません)'}
        </label>
        <div className="note">ブラウザの中で 1 フレームずつ描いて圧縮するので、重い場面でもコマ落ちしません。MP4 を作れないブラウザでは WebM を選んでください</div>
      </Panel>
      <div className="row">
        <button type="button" className="bbtn" disabled={busy} onClick={() => engine.renderImage()}>画像をレンダリング (F12)</button>
        <button type="button" className="bbtn" disabled={busy} onClick={() => engine.renderAnimation()}>アニメーションをレンダリング (Ctrl F12)</button>
      </div>
    </>
  );
}
