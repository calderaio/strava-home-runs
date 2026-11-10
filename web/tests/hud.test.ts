import { describe, expect, test } from 'bun:test';
import { run } from './fixtures.ts';
import { buildHud, defaultTitles, formatClock, histScale, stillRunning } from '../src/lib/hud.ts';

const withDur = (d: number[], year = 2024) => d.map((dur) => run([0, 0, 1, 1], [0, dur], { year, dur }));

describe('histogram scale', () => {
  test('bin width and ticks follow the longest run', () => {
    expect(histScale(75 * 60)).toEqual([2.5, [[0, '0m'], [15, '15m'], [30, '30m'], [45, '45m'], [60, '60m'], [75, '75m']]]);
    const [b2, t2] = histScale(75 * 60 + 1);
    expect(b2).toBe(5);
    expect(t2).toEqual([[0, '0h'], [30, '0h30'], [60, '1h']]);
    expect(histScale(150 * 60)[1].map((t) => t[1])).toEqual(['0h', '0h30', '1h', '1h30', '2h', '2h30']);
    expect(histScale(150 * 60 + 1)[1].map((t) => t[1])).toEqual(['0h', '1h', '2h']);
  });

  test('runs are binned by finish time; the longest goes into the last bin', () => {
    // longest 60 min -> 2.5-minute bins, 24 bins
    const h = buildHud(withDur([0, 149, 150, 151, 3600]), 't', 's');
    expect(h.binMin).toBe(2.5);
    expect(h.full.length).toBe(24);
    expect(Array.from(h.bins)).toEqual([0, 0, 1, 1, 23]);
    expect(h.full[0]).toBe(2);
    expect(h.full[1]).toBe(2);
    expect(h.full[23]).toBe(1);
    expect(h.fullMax).toBe(2);
    expect(h.span).toBe(60);
  });
});

describe('counters and labels', () => {
  test('a run finishing exactly at t is home, not still running', () => {
    const h = buildHud(withDur([100, 200, 200, 300]), 't', 's');
    expect(stillRunning(h, 0)).toBe(4);
    expect(stillRunning(h, 99.9)).toBe(4);
    expect(stillRunning(h, 100)).toBe(3);
    expect(stillRunning(h, 199.9)).toBe(3);
    expect(stillRunning(h, 200)).toBe(1);
    expect(stillRunning(h, 300)).toBe(0);
  });

  test('clock format', () => {
    expect(formatClock(0)).toBe('0:00:00');
    expect(formatClock(59.9)).toBe('0:00:59');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-3)).toBe('0:00:00');
  });

  test('default titles', () => {
    expect(defaultTitles(withDur([1, 2], 2021))).toEqual({ title: 'HOME RUNS 2021', subtitle: '2 runs in 2021' });
    expect(defaultTitles([...withDur([1], 2020), ...withDur([1], 2026)]))
      .toEqual({ title: 'HOME RUNS since 2020', subtitle: '2 runs between 2020 and 2026' });
    expect(defaultTitles(withDur([1], 2022)).subtitle).toBe('1 run in 2022');
  });
});
