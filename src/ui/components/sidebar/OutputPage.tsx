import { useState } from 'react';
import { FPS } from '../../../core/constants';
import { t } from '../../../core/i18n';
import {
  OUTPUT_PRESETS, RESOLUTION_PRESETS, VIDEO_FORMATS, VIDEO_QUALITIES, frameSpan, presetIndex, regionPixels, type OutputPreset, type VideoFormat, type VideoQuality,
} from '../../../core/output';
import { useEngine, useUi } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { BCheck } from '../controls/BCheck';
import { BSelect } from '../controls/BSelect';
import { NumField } from '../NumField';
import { Panel } from './Panel';

// 自分のプリセット (ブラウザに保存する)
const USER_KEY = 'webgl-grid-output-presets';
function loadUser(): OutputPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(USER_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter(p => p && typeof p.name === 'string' && p.width > 0 && p.height > 0) : [];
  } catch { return []; }
}
function saveUser(list: OutputPreset[]) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(list)); } catch { /* 保存できなくても使える */ }
}
const same = (p: OutputPreset, o: { width: number; height: number; format: VideoFormat; quality: VideoQuality }) =>
  p.width === o.width && p.height === o.height && p.format === o.format && p.quality === o.quality;

// --- 出力 (Blender の出力プロパティ): レンダリングする画像・動画の大きさ・範囲・形式 ---
// 出力のプリセット (大きさ・形式・画質をまとめて)。いまの設定を自分のプリセットとして保存できる。
// レンダー範囲 (Ctrl+B) と、モーションブラーもここで
export function OutputPage() {
  const engine = useEngine();
  const o = useUi(s => s.output);
  const start = useUi(s => s.start);
  const end = useUi(s => s.end);
  const busy = useUi(s => !!s.rendering);
  const hasMusic = !!engine.music.file;
  const preset = presetIndex(o.width, o.height);
  const span = frameSpan(start, end);
  const [user, setUser] = useState(loadUser);
  const all = [...OUTPUT_PRESETS.map(p => ({ ...p, name: t(p.name) })), ...user];
  const cur = all.findIndex(p => same(p, o)), mine = cur >= OUTPUT_PRESETS.length;
  const region = o.region ? regionPixels(o) : null;
  return (
    <>
      <Panel title={t('出力のプリセット')}>
        <div className="prop">
          <label htmlFor="out-all-preset">{t('プリセット')}</label>
          <BSelect id="out-all-preset" label={t('出力のプリセット')} value={cur >= 0 ? cur : null} placeholder={t('カスタム')}
                   onChange={i => { const p = all[i]; if (p) engine.output.set({ width: p.width, height: p.height, format: p.format, quality: p.quality }); }}
                   options={[
                     { group: t('組み込み'), options: OUTPUT_PRESETS.map((p, i) => ({ value: i, label: t(p.name) })) },
                     ...(user.length ? [{ group: t('自分のプリセット'), options: user.map((p, i) => ({ value: OUTPUT_PRESETS.length + i, label: p.name })) }] : []),
                   ]} />
        </div>
        <div className="row">
          <button type="button" className="bbtn" disabled={cur >= 0}
                  onClick={() => {
                    const q = t(VIDEO_QUALITIES.find(v => v.key === o.quality)!.name), f = VIDEO_FORMATS.find(v => v.key === o.format)!.ext.toUpperCase();
                    const next = [...user, { name: `${o.width}×${o.height}・${f}・${q}`, width: o.width, height: o.height, format: o.format, quality: o.quality }];
                    setUser(next); saveUser(next);
                  }}>{t('いまの設定を保存')}</button>
          <button type="button" className="bbtn" disabled={!mine}
                  onClick={() => { const next = user.filter((_, i) => OUTPUT_PRESETS.length + i !== cur); setUser(next); saveUser(next); }}>{t('このプリセットを消す')}</button>
        </div>
      </Panel>
      <Panel title={t('解像度')}>
        <div className="prop">
          <label htmlFor="out-preset">{t('プリセット')}</label>
          <BSelect id="out-preset" label={t('解像度のプリセット')} value={preset} placeholder={t('カスタム')}
                   onChange={i => { const p = RESOLUTION_PRESETS[i]; if (p) engine.output.set({ width: p.width, height: p.height }); }}
                   options={RESOLUTION_PRESETS.map((p, i) => ({ value: i, label: t(p.name) }))} />
          <label htmlFor="out-w">{t('解像度 X')}</label>
          <NumField id="out-w" label={t('解像度 X')} value={o.width} min={16} step={2} onCommit={v => engine.output.set({ width: v })} />
          <label htmlFor="out-h">Y</label>
          <NumField id="out-h" label={t('解像度 Y')} value={o.height} min={16} step={2} onCommit={v => engine.output.set({ height: v })} />
        </div>
        <div className="note">{t('いまの視点から、この大きさで描きます。縦の見える範囲はビューポートと同じで、縦横比が違うと横の範囲が変わります。地面のグリッドと選択の輪郭線は描きません')}</div>
      </Panel>
      <Panel title={t('レンダー範囲')}>
        <div className="note">{region ? t('{w} × {h} (左上 {x}, {y}) だけを書き出します', { w: region.w, h: region.h, x: region.x, y: region.y }) : t('出力の枠の全体を書き出します')}</div>
        <div className="row">
          <button type="button" className="bbtn" onClick={() => engine.ui.set({ regionSelect: true })}>{t('ビューポートで囲む (Ctrl+B)')}</button>
          <button type="button" className="bbtn" disabled={!o.region} onClick={() => engine.output.set({ region: null })}>{t('消す (Ctrl+Alt+B)')}</button>
        </div>
      </Panel>
      <Panel title={t('モーションブラー')} head={<BCheck checked={o.motionBlur} label={t('モーションブラーを使う')} onChange={motionBlur => engine.output.set({ motionBlur })} />}>
        <BSlider label={t('シャッター')} value={o.shutter} min={0.05} max={1} step={0.05} digits={2} off={!o.motionBlur} onChange={shutter => engine.output.set({ shutter })} />
        <BSlider label={t('サンプル数')} value={o.blurSamples} min={2} max={32} step={1} digits={0} off={!o.motionBlur} onChange={blurSamples => engine.output.set({ blurSamples })} />
        <div className="note">{t('動いている物を、シャッターが開いているあいだ (フレームの長さ × シャッター) の動きでぼかします。1 フレームをサンプル数だけ描いて重ねるので、そのぶん時間がかかります')}</div>
      </Panel>
      <Panel title={t('フレーム範囲')}>
        <div className="prop">
          <label htmlFor="out-start">{t('開始')}</label>
          <NumField id="out-start" label={t('レンダリングの開始フレーム')} value={start} min={0} onCommit={v => engine.clock.setRange(v, end)} />
          <label htmlFor="out-end">{t('終了')}</label>
          <NumField id="out-end" label={t('レンダリングの終了フレーム')} value={end} min={0} onCommit={v => engine.clock.setRange(start, v)} />
          <label>{t('長さ')}</label>
          <span className="note">{t('{count} フレーム ({seconds} 秒・{fps} fps)', { count: span.count, seconds: span.seconds.toFixed(1), fps: FPS })}</span>
        </div>
      </Panel>
      <Panel title={t('動画')}>
        <div className="prop">
          <label htmlFor="out-format">{t('形式')}</label>
          <BSelect<VideoFormat> id="out-format" label={t('動画の形式')} value={o.format} onChange={format => engine.output.set({ format })}
                   options={VIDEO_FORMATS.map(f => ({ value: f.key, label: t(f.name) }))} />
          <label htmlFor="out-quality">{t('画質')}</label>
          <BSelect<VideoQuality> id="out-quality" label={t('動画の画質')} value={o.quality} onChange={quality => engine.output.set({ quality })}
                   options={VIDEO_QUALITIES.map(q => ({ value: q.key, label: t(q.name) }))} />
        </div>
        <BCheck checked={o.audio} onChange={audio => engine.output.set({ audio })}>{hasMusic ? t('曲を入れる') : t('曲を入れる (曲を読み込んでいません)')}</BCheck>
        <div className="note">{t('ブラウザの中で 1 フレームずつ描いて圧縮するので、重い場面でもコマ落ちしません。MP4 を作れないブラウザでは WebM を選んでください')}</div>
      </Panel>
      <div className="row">
        <button type="button" className="bbtn" disabled={busy} onClick={() => engine.output.renderImage()}>{t('画像をレンダリング (F12)')}</button>
        <button type="button" className="bbtn" disabled={busy} onClick={() => engine.output.renderAnimation()}>{t('アニメーションをレンダリング (Ctrl F12)')}</button>
      </div>
    </>
  );
}
