// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BSlider } from './BSlider';
import { NumField } from './NumField';

afterEach(cleanup);

describe('BSlider', () => {
  const setup = (value = 0.5) => {
    const onChange = vi.fn();
    render(<BSlider label="まばたき" value={value} min={0} max={1} step={0.01} onChange={onChange} />);
    return { onChange, slider: screen.getByRole('slider', { name: 'まばたき' }) };
  };

  it('名前と値を表示する', () => {
    const { slider } = setup();
    expect(slider.textContent).toContain('まばたき');
    expect(slider.textContent).toContain('0.50');
    expect(slider.getAttribute('aria-valuenow')).toBe('0.5');
  });

  it('矢印キーで 1 刻み、Shift+矢印で 10 刻み動かす (範囲の外には出ない)', () => {
    const { slider, onChange } = setup();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(0.51);
    fireEvent.keyDown(slider, { key: 'ArrowLeft', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(0.4);
    cleanup();
    const top = setup(1);
    fireEvent.keyDown(top.slider, { key: 'ArrowRight' });
    expect(top.onChange).not.toHaveBeenCalled();
  });

  it('Enter で数値を打てて、範囲の外の値は範囲に収める', () => {
    const { slider, onChange } = setup();
    fireEvent.keyDown(slider, { key: 'Enter' });
    const input = slider.querySelector('input')!;
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('0 をまたぐ範囲は、0 から値までに帯を引く', () => {
    render(<BSlider label="回転 X" value={-90} min={-180} max={180} step={1} digits={0} unit="°" onChange={() => {}} />);
    const fill = screen.getByRole('slider', { name: '回転 X' }).querySelector('.fill') as HTMLElement;
    expect(fill.style.left).toBe('25%');
    expect(fill.style.width).toBe('25%');
  });
});

describe('NumField', () => {
  it('Enter で決めた値を知らせる', () => {
    const onCommit = vi.fn();
    render(<NumField label="終了フレーム" value={250} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton', { name: '終了フレーム' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '120' } });
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.blur(input); });
    expect(onCommit).toHaveBeenCalledWith(120);
  });

  it('Esc でやめたら知らせず、元の値に戻す', () => {
    const onCommit = vi.fn();
    render(<NumField label="開始フレーム" value={0} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton', { name: '開始フレーム' }) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '50' } });
    act(() => { fireEvent.keyDown(input, { key: 'Escape' }); fireEvent.blur(input); });
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('0');
  });

  it('打っているあいだのキーはショートカットに伝えない', () => {
    const onKey = vi.fn();
    addEventListener('keydown', onKey);
    render(<NumField label="フレーム" value={0} onCommit={() => {}} />);
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'フレーム' }), { key: 'x' });
    removeEventListener('keydown', onKey);
    expect(onKey).not.toHaveBeenCalled();
  });
});
