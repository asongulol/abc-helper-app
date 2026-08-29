'use client';

import { useEffect, useState } from 'react';
import { saveMoodCheckin } from '@/server/actions/portal';

const MOODS = ['😞', '😕', '🙂', '😀', '🤩'];

const phDate = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());

interface Props {
  /** Which check-in applies right now (server-decided: shift window + 16h DB
   *  lookback) — null when none is due. */
  prompt: 'start' | 'end' | null;
  /** Called once the mood decision is made (answered, already done today, or
   *  none due) — gates the doc reminder so the two overlays never stack. */
  onDone: () => void;
}

/**
 * Shift mood pop-out (legacy portal Home, portal/index.html ~1563): "How are
 * you feeling today?" near shift start / "Tell me how your day went?" near
 * shift end. Tapping an emoji is the ONLY way to dismiss. The sessionStorage
 * per-day guard covers the gap before the DB write commits (the server's 16h
 * lookback handles everything across sessions/devices).
 */
export const MoodCheckinOverlay = ({ prompt, onDone }: Props) => {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let done = false;
    try {
      done = sessionStorage.getItem(`mood:${prompt}:${phDate()}`) === '1';
    } catch {
      /* ignore */
    }
    if (prompt && !done) setOpen(true);
    else onDone();
  }, [prompt, onDone]);

  if (!open || !prompt) return null;

  const pick = (mood: number) => {
    setOpen(false);
    onDone();
    try {
      sessionStorage.setItem(`mood:${prompt}:${phDate()}`, '1');
    } catch {
      /* ignore */
    }
    void saveMoodCheckin({ mood, kind: prompt });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Shift mood check-in"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,28,51,.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: 60,
      }}
    >
      <div
        className="card"
        style={{ maxWidth: 360, width: '100%', textAlign: 'center', margin: 0 }}
      >
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 2 }}>
          {prompt === 'end' ? 'Tell me how your day went?' : 'How are you feeling today?'}
        </div>
        <div className="sub" style={{ marginTop: 0, marginBottom: 12 }}>
          Tap an emoji to continue.
        </div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          {MOODS.map((e, i) => (
            <button
              key={e}
              type="button"
              onClick={() => pick(i + 1)}
              aria-label={`mood ${i + 1}`}
              style={{
                cursor: 'pointer',
                background: 'none',
                border: 'none',
                fontSize: 36,
                padding: 0,
                lineHeight: 1,
              }}
            >
              {e}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
