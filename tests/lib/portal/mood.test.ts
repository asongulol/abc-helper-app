import { describe, expect, it } from 'vitest';
import { moodPromptFor, parseShiftHM } from '@/lib/portal/mood';

const MIN = (h: number, m = 0) => h * 60 + m;

describe('parseShiftHM', () => {
  it('parses HH:MM and HH:MM:SS; null when unset', () => {
    expect(parseShiftHM('09:30')).toBe(570);
    expect(parseShiftHM('21:00:00')).toBe(1260);
    expect(parseShiftHM(null)).toBeNull();
    expect(parseShiftHM('')).toBeNull();
  });
});

describe('moodPromptFor', () => {
  const start = MIN(21); // 9pm PHT shift start (overnight US-hours shift)
  const end = MIN(6); // 6am PHT shift end

  it('prompts START within 2h after shift start, once', () => {
    expect(moodPromptFor(MIN(21, 30), start, end, [])).toBe('start');
    expect(moodPromptFor(MIN(23), start, end, [])).toBe('start');
    expect(moodPromptFor(MIN(21, 30), start, end, ['start'])).toBeNull();
    expect(moodPromptFor(MIN(20, 59), start, end, [])).toBeNull(); // before shift
  });

  it('prompts END within 2h after shift end, across midnight, once', () => {
    expect(moodPromptFor(MIN(7), start, end, ['start'])).toBe('end');
    expect(moodPromptFor(MIN(7), start, end, ['start', 'end'])).toBeNull();
    expect(moodPromptFor(MIN(9), start, end, ['start'])).toBeNull(); // window passed
  });

  it('start window wins when windows would overlap', () => {
    // 1h shift: 09:00–10:00 → at 10:30 both windows are open; start is asked first.
    expect(moodPromptFor(MIN(10, 30), MIN(9), MIN(10), [])).toBe('start');
    expect(moodPromptFor(MIN(10, 30), MIN(9), MIN(10), ['start'])).toBe('end');
  });

  it('no shift configured → one generic START per lookback window', () => {
    expect(moodPromptFor(MIN(14), null, null, [])).toBe('start');
    expect(moodPromptFor(MIN(14), null, null, ['start'])).toBeNull();
    expect(moodPromptFor(MIN(14), MIN(9), null, [])).toBe('start'); // half-set = unset
  });
});
