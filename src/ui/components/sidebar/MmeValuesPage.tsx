import type { ReactNode } from 'react';
import { t } from '../../../core/i18n';
import type { Obj } from '../../../engine/types';
import type { MmeParamUi, MmeValuesUi } from '../../../engine/UiChannel';
import { useEngine, useUi } from '../../EngineContext';
import { BSlider } from '../BSlider';
import { BCheck } from '../controls/BCheck';
import { ColorField } from '../fields';
import { NumField } from '../NumField';
import { Empty, Panel } from './Panel';

// --- MME (選んでいる MME の物か MMD モデルの MME の値): コントローラーは項目のスライダー (0〜1)、アクセサリは X〜Tr (数値の欄。
// Rx〜Rz は度。Si・Tr はスライダーも)、どれにも当てた .fx ごとの「エフェクトのパラメータ」(色は色の欄)。
// 値ごとの ◆ は、いまのフレームのキーを打つ (あれば消す)。キーのある値は ◆、ない値は ◇ ---
const AXES = ['x', 'y', 'z', 'w'];
const SLIDER_MAX: Record<string, number> = { Si: 10, Tr: 1 }; // (Si・Tr のスライダーの範囲。Si は数値の欄ならもっと大きくできる)

export function MmeValuesPage() {
  const engine = useEngine();
  const sel = useUi(s => s.sel);
  const values = useUi(s => s.mme.values);
  useUi(s => s.frame); // (◆ のキーのあるなしは、いまのフレームとキーで変わる)
  useUi(s => s.keysVersion);
  const obj = values && values.objId === sel?.id ? engine.world.find(values.objId) : null;
  if (!values || !obj) {
    return <Panel title={t('MME')}><Empty>{t('MME の物 (コントローラー・アクセサリ) か MMD モデルを選ぶと、ここで MME の値を変えられます。')}</Empty></Panel>;
  }
  return (
    <>
      {values.kind === 'controller' && <ControllerPanel obj={obj} values={values} />}
      {values.kind === 'accessory' && <AccessoryPanel obj={obj} values={values} />}
      {values.kind !== 'controller' && <ParamsPanel obj={obj} values={values} />}
    </>
  );
}

// 1 つの値の行: 中身と、右に ◆
function Row({ children, keyButton }: { children: ReactNode; keyButton: ReactNode }) {
  return <div className="mme-val">{children}{keyButton}</div>;
}

// ◆: values (チャンネルの名前 → 画面の値) のどれかに、いまのフレームのキーがあれば消す。なければ打つ
function KeyButton({ obj, label, values }: { obj: Obj; label: string; values: Record<string, number> }) {
  const engine = useEngine();
  const keyed = engine.mme.hasKey(obj, Object.keys(values));
  return (
    <button type="button" className={keyed ? 'mme-key keyed' : 'mme-key'} aria-pressed={keyed} aria-label={t('{name} のキー', { name: label })}
            title={keyed ? t('{name} の、このフレームのキーを消す', { name: label }) : t('{name} のいまの値を、このフレームのキーにする', { name: label })}
            onClick={() => engine.mme.toggleKey(obj, values)}>{keyed ? '◆' : '◇'}</button>
  );
}

function ControllerPanel({ obj, values }: { obj: Obj; values: MmeValuesUi }) {
  const engine = useEngine();
  return (
    <Panel title={t('コントローラーの項目')}>
      {values.items.length ? values.items.map(({ name, value }) => (
        <Row key={name} keyButton={<KeyButton obj={obj} label={name} values={{ [name]: value }} />}>
          <BSlider label={name} value={value} min={0} max={1} step={0.01} onChange={v => engine.mme.setItem(obj, name, v)} />
        </Row>
      )) : <Empty>{t('この名前の項目を読む .fx がありません。.fx を当てると、その .fx が読む項目がここに並びます。')}</Empty>}
    </Panel>
  );
}

function AccessoryPanel({ obj, values }: { obj: Obj; values: MmeValuesUi }) {
  const engine = useEngine();
  return (
    <Panel title={t('アクセサリ')}>
      {values.items.map(({ name, value }) => {
        const deg = name.startsWith('R');
        const set = (v: number) => engine.mme.setItem(obj, name, v);
        return (
          <div key={name} className="mme-acc">
            <label>{name}</label>
            <NumField label={deg ? t('{name} (度)', { name }) : name} value={+value.toFixed(3)} digits={deg ? 1 : 3} step={deg ? 1 : name === 'Si' || name === 'Tr' ? 0.01 : 0.1}
                      min={name === 'Si' || name === 'Tr' ? 0 : undefined} max={name === 'Tr' ? 1 : undefined} onCommit={set} />
            <KeyButton obj={obj} label={name} values={{ [name]: value }} />
            {name in SLIDER_MAX && <BSlider label={t('{name} のスライダー', { name })} value={Math.min(value, SLIDER_MAX[name])} min={0} max={SLIDER_MAX[name]} step={0.01} onChange={set} />}
          </div>
        );
      })}
      <div className="note">{t('位置は MMD の単位、回転は度。.fx は CONTROLOBJECT でこの値を読みます')}</div>
    </Panel>
  );
}

function ParamsPanel({ obj, values }: { obj: Obj; values: MmeValuesUi }) {
  return (
    <Panel title={t('エフェクトのパラメータ')}>
      {values.effects.length ? values.effects.map(({ effect, params }) => (
        <div key={`${effect.folder}/${effect.path}`} className="mme-fx-params" role="group" aria-label={effect.name}>
          <div className="mme-head mme-name" title={effect.name}>{effect.name}</div>
          {params.length ? params.map(p => <ParamRow key={p.name} obj={obj} effect={effect} param={p} />) : <div className="note">{t('いじれるパラメータはありません')}</div>}
        </div>
      )) : <Empty>{values.kind === 'accessory' ? t('このアクセサリには .fx が当たっていません') : t('このモデルには .fx が当たっていません')}</Empty>}
    </Panel>
  );
}

// パラメータ 1 つ: float・int はスライダー、bool はチェック、色は色の欄 (float4 は w のスライダーも)、ほかのベクトルは成分ごとのスライダー
function ParamRow({ obj, effect, param: p }: { obj: Obj; effect: { folder: string; path: string }; param: MmeParamUi }) {
  const engine = useEngine();
  const set = (v: number[]) => engine.mme.setParam(obj, effect.folder, effect.path, p.name, v);
  const setAt = (i: number, v: number) => set(p.value.map((x, k) => (k === i ? v : x)));
  const keyButton = <KeyButton obj={obj} label={p.label} values={Object.fromEntries(p.channels.map((ch, i) => [ch, p.value[i]]))} />;
  const range = p.max - p.min;
  const step = p.type === 'int' ? 1 : range > 0 ? 10 ** Math.floor(Math.log10(range)) / 100 : 0.01;
  const digits = Math.max(0, Math.min(4, -Math.floor(Math.log10(step))));
  const slider = (label: string, i: number) => (
    <BSlider key={i} label={label} value={p.value[i]} min={p.min} max={p.max} step={step} digits={digits} onChange={v => setAt(i, v)} />
  );
  if (p.type === 'bool') return <Row keyButton={keyButton}><BCheck checked={p.value[0] !== 0} onChange={on => set([on ? 1 : 0])}>{p.label}</BCheck></Row>;
  if (p.type === 'float' || p.type === 'int') return <Row keyButton={keyButton}>{slider(p.label, 0)}</Row>;
  if (p.color) {
    return (
      <Row keyButton={keyButton}>
        <div className="mme-vec">
          <ColorField label={p.label} screen value={[p.value[0], p.value[1], p.value[2]]} onChange={c => set([...c, ...p.value.slice(3)])} />
          {p.value.length > 3 && slider(`${p.label}.w`, 3)}
        </div>
      </Row>
    );
  }
  return (
    <Row keyButton={keyButton}>
      <div className="mme-vec" role="group" aria-label={p.label}>
        <div className="mme-name" title={p.label}>{p.label}</div>
        {p.value.map((_, i) => slider(`${p.label}.${AXES[i]}`, i))}
      </div>
    </Row>
  );
}
