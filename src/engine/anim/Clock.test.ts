import { describe, expect, it, vi } from 'vitest';
import { Clock, type TimeSource } from './Clock';

describe('Clock', () => {
  it('最初は 0〜250 フレームで止まっている', () => {
    const c = new Clock();
    expect([c.frame, c.start, c.end, c.playing]).toEqual([0, 0, 250, false]);
  });

  it('再生中は update で時刻が進み、advance を知らせる', () => {
    const c = new Clock();
    const advance = vi.fn();
    c.events.on('advance', advance);
    c.setPlaying(true);
    c.update(0.5);
    expect(c.frame).toBe(15);
    expect(advance).toHaveBeenCalledWith(0.5);
    c.setPlaying(false);
    c.update(0.5);
    expect(c.frame).toBe(15);
  });

  it('終了フレームを越えると、開始フレームへ飛んで (seek) 繰り返す', () => {
    const c = new Clock();
    c.setRange(10, 20);
    const seek = vi.fn();
    c.events.on('seek', seek);
    c.seekFrame(19);
    c.setPlaying(true);
    c.update(2 / 30);
    expect(c.frame).toBe(10);
    expect(seek).toHaveBeenLastCalledWith(10 / 30, 30);
  });

  it('最後まで行っていたら、再生を始めたときに最初から', () => {
    const c = new Clock();
    c.setRange(5, 20);
    c.seekFrame(20);
    c.setPlaying(true);
    expect(c.frame).toBe(5);
  });

  it('曲が鳴っていれば、その再生位置に寄せて進む (大きくずれたら一気に合わせる)', () => {
    const c = new Clock();
    let pos = 3;
    const source: TimeSource = { current: () => pos, waiting: () => false, resume: () => {} };
    c.source = source;
    c.setPlaying(true);
    c.update(1 / 60);
    expect(c.t).toBeCloseTo(3);
    pos = 3.05;
    c.update(1 / 60);
    expect(c.t).toBeCloseTo(3 + 1 / 60 + (3.05 - 3) * 0.1);
  });

  it('自動再生を止められた曲を待っているあいだは進まず、▶ で曲を鳴らす (止めない)', () => {
    const c = new Clock();
    const source = { current: () => null, waiting: () => true, resume: vi.fn() };
    c.source = source;
    c.setPlaying(true);
    c.update(1);
    expect(c.t).toBe(0);
    c.togglePlay();
    expect(source.resume).toHaveBeenCalled();
    expect(c.playing).toBe(true);
  });

  it('範囲は整数にそろえ、終了は開始より後にする。fitEnd は中身の長さに合わせる', () => {
    const c = new Clock();
    c.setRange(30.4, 10);
    expect([c.start, c.end]).toEqual([30, 31]);
    c.setRange(0, 250);
    c.fitEnd(1234.2);
    expect(c.end).toBe(1235);
    c.fitEnd(0);
    expect(c.end).toBe(1235);
  });

  it('フレームが変わったときだけ change を知らせる', () => {
    const c = new Clock();
    const change = vi.fn();
    c.events.on('change', change);
    c.setPlaying(true);
    change.mockClear();
    c.update(0.01);
    expect(change).not.toHaveBeenCalled();
    c.update(0.03);
    expect(change).toHaveBeenCalledOnce();
  });
});
