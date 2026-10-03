// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NumField } from '../NumField';
import { BCheck } from './BCheck';
import { BSelect } from './BSelect';
import { ColorPicker } from './ColorPicker';

afterEach(cleanup);
beforeAll(() => {
  // jsdom にないもの
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => true;
});

describe('BSelect (選択肢)', () => {
  const OPTS = [{ value: 'a', label: 'りんご' }, { value: 'b', label: 'バナナ', disabled: true }, { value: 'c', label: 'みかん' }];
  function Harness({ onChange }: { onChange: (v: string) => void }) {
    const [v, setV] = useState('a');
    return <BSelect label="果物" value={v} options={OPTS} onChange={x => { setV(x); onChange(x); }} />;
  }
  it('押すと一覧が開き、選ぶと閉じて知らせる', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const box = screen.getByRole('combobox', { name: '果物' });
    expect(box.textContent).toBe('りんご');
    expect(box.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(box);
    expect(box.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['りんご', 'バナナ', 'みかん']);
    expect(screen.getByRole('option', { name: 'りんご' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('option', { name: 'バナナ' })); // 選べない
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: 'みかん' }));
    expect(onChange).toHaveBeenLastCalledWith('c');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box.textContent).toBe('みかん');
  });
  it('キーボード: 閉じたまま ↑↓ で前後 (選べないものは飛ばす)、Enter で開いて ↓ Enter で選ぶ、Esc で閉じる', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const box = screen.getByRole('combobox', { name: '果物' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith('a');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'みかん' }).id);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    fireEvent.keyDown(box, { key: ' ' });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.getAttribute('aria-expanded')).toBe('false');
  });
  it('グループの見出しを出し、値が選択肢にないときは placeholder を出す', () => {
    render(<BSelect label="ボーン" value={9} placeholder="カスタム" onChange={() => {}}
                    options={[{ group: '体', options: [{ value: 1, label: 'センター' }] }, { group: '腕', options: [{ value: 2, label: '右腕' }] }]} />);
    const box = screen.getByRole('combobox', { name: 'ボーン' });
    expect(box.textContent).toBe('カスタム');
    fireEvent.click(box);
    expect(screen.getAllByRole('group').map(g => g.getAttribute('aria-label'))).toEqual(['体', '腕']);
  });
  it('操作したキーは、ショートカットに伝えない', () => {
    const onKey = vi.fn();
    render(<div onKeyDown={onKey}><BSelect label="果物" value="a" options={OPTS} onChange={() => {}} /></div>);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    expect(onKey).not.toHaveBeenCalled();
  });
});

describe('BCheck (チェック)', () => {
  it('押すと切り替わり、パネルの見出しの中でも親には伝えない', () => {
    const onChange = vi.fn(), onParent = vi.fn();
    render(<div onClick={onParent}><BCheck checked={false} onChange={onChange}>使う</BCheck></div>);
    const box = screen.getByRole('checkbox', { name: '使う' });
    expect(box.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(onParent).not.toHaveBeenCalled();
  });
});

describe('NumField (ドラッグ・‹ ›・↑↓)', () => {
  const setup = (value = 10, extra = {}) => {
    const onCommit = vi.fn();
    render(<NumField label="開始" value={value} step={1} min={0} onCommit={onCommit} {...extra} />);
    return { onCommit, field: screen.getByRole('spinbutton', { name: '開始' }) };
  };
  it('左右にドラッグすると値が変わる (4 ピクセルで 1。最小値より下には行かない)', () => {
    const { field, onCommit } = setup();
    fireEvent.pointerDown(field, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(field, { clientX: 120, pointerId: 1 });
    expect(onCommit).toHaveBeenLastCalledWith(15);
    fireEvent.pointerMove(field, { clientX: 0, pointerId: 1 });
    expect(onCommit).toHaveBeenLastCalledWith(0);
    fireEvent.pointerUp(field, { pointerId: 1 });
    expect(document.activeElement).not.toBe(field); // ドラッグしたときは打ち込みにしない
  });
  it('動かさずに離すと打ち込みになる', () => {
    const { field, onCommit } = setup();
    fireEvent.pointerDown(field, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerUp(field, { clientX: 101, pointerId: 1 });
    expect(document.activeElement).toBe(field);
    expect(onCommit).not.toHaveBeenCalled();
  });
  it('‹ › で 1 段ずつ、打ち込み中の ↑↓ でも 1 段ずつ', () => {
    const { field, onCommit } = setup();
    fireEvent.click(screen.getByRole('button', { name: '開始を増やす' }));
    expect(onCommit).toHaveBeenLastCalledWith(11);
    fireEvent.click(screen.getByRole('button', { name: '開始を減らす' }));
    expect(onCommit).toHaveBeenLastCalledWith(9);
    fireEvent.focus(field);
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(onCommit).toHaveBeenLastCalledWith(11);
  });
});

describe('ColorPicker (色選び)', () => {
  it('16 進で打つと、その色を知らせる。Enter で終わる', () => {
    const onChange = vi.fn(), onDone = vi.fn();
    render(<ColorPicker label="色" rgb={[1, 0, 0]} onChange={onChange} onDone={onDone} />);
    const hex = screen.getByRole('textbox', { name: '色 (16 進)' });
    expect((hex as HTMLInputElement).value).toBe('#ff0000');
    fireEvent.change(hex, { target: { value: '#00ff00' } });
    fireEvent.keyDown(hex, { key: 'Enter' });
    fireEvent.blur(hex);
    expect(onChange).toHaveBeenLastCalledWith([0, 1, 0]);
    expect(onDone).toHaveBeenCalled();
  });
  it('色相のバーを矢印キーで動かす', () => {
    const onChange = vi.fn();
    render(<ColorPicker label="色" rgb={[1, 0, 0]} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('slider', { name: '色の色相' }), { key: 'ArrowRight', shiftKey: true }); // 36° 黄色寄りへ
    const [r, g, b] = onChange.mock.lastCall![0];
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0.6);
    expect(b).toBeCloseTo(0);
  });
});
