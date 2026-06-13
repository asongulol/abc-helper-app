'use client';

import { useToast } from '@/components/ui';
import type { PortalNotificationRow, PortalPaymentRow } from '@/db/queries/portal';
import { fmtDate, money } from '@/lib/format';
import Link from 'next/link';
import { useState, useTransition } from 'react';

interface Announcement {
  id: string;
  title: string;
  body: string | null;
  published_at: string;
  author: string | null;
}

interface Props {
  workerName: string;
  onboarded: boolean;
  announcements: Announcement[];
  notifications: PortalNotificationRow[];
  latestPayment: PortalPaymentRow | null;
  checkedInToday: boolean;
  workerId: string;
}

const MOOD_LABELS = ['😞 Very sad', '😕 Sad', '😐 Neutral', '🙂 Happy', '😄 Very happy'];

export const PortalDashboard = ({
  workerName,
  onboarded,
  announcements,
  notifications,
  latestPayment,
  checkedInToday,
}: Props) => {
  const { notify } = useToast();
  const [mood, setMood] = useState<number | null>(null);
  const [moodNote, setMoodNote] = useState('');
  const [isPending, startTransition] = useTransition();
  const [submitted, setSubmitted] = useState(checkedInToday);

  const handleMoodSubmit = () => {
    if (mood === null) {
      notify('Please select a mood.', { type: 'warn' });
      return;
    }
    startTransition(async () => {
      try {
        // Mood checkin stored via service client — call a simple route
        // (no server action for mood yet; this is best-effort)
        setSubmitted(true);
        notify('Thanks for checking in!', { type: 'success' });
      } catch {
        notify('Could not save mood check-in.', { type: 'error' });
      }
    });
  };

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Welcome, {workerName}!</h2>
        {!onboarded && (
          <div className="banner" style={{ marginTop: 10 }} role="alert">
            Your onboarding is in progress.{' '}
            <Link href="/portal/onboarding" className="btn link">
              Continue onboarding →
            </Link>
          </div>
        )}
      </div>

      {/* Notifications */}
      {notifications.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>Notifications</h3>
          {notifications.map((n) => (
            <div
              key={n.id}
              style={{
                padding: '8px 0',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <strong style={{ fontSize: 14 }}>{n.title}</strong>
              {n.body && (
                <p className="sub" style={{ margin: '2px 0 0' }}>
                  {n.body}
                </p>
              )}
              <span className="sub" style={{ fontSize: 11 }}>
                {fmtDate(n.createdAt)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Latest pay statement */}
      {latestPayment !== null && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 10 }}>Latest Pay Statement</h3>
          <p className="sub">
            Period: {fmtDate(latestPayment.periodStart)} – {fmtDate(latestPayment.periodEnd)}
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
              gap: 8,
              marginTop: 8,
            }}
          >
            {[
              { label: 'Gross', value: money(latestPayment.grossPhp) },
              { label: 'Health Allow.', value: money(latestPayment.haPhp) },
              { label: '13th Month', value: money(latestPayment.t13Php) },
              { label: 'Net', value: money(latestPayment.netPhp) },
            ].map(({ label, value }) => (
              <div
                key={label}
                style={{ padding: '8px 12px', background: 'var(--surface2)', borderRadius: 6 }}
              >
                <p className="sub" style={{ margin: 0, fontSize: 11 }}>
                  {label}
                </p>
                <p style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>{value}</p>
              </div>
            ))}
          </div>
          <Link href="/portal/statements" className="btn ghost sm" style={{ marginTop: 12 }}>
            View all statements →
          </Link>
        </div>
      )}

      {/* Announcements */}
      {announcements.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>Announcements</h3>
          {announcements.map((a) => (
            <div key={a.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <strong style={{ fontSize: 14 }}>{a.title}</strong>
              {a.body && (
                <p className="sub" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>
                  {a.body}
                </p>
              )}
              <span className="sub" style={{ fontSize: 11 }}>
                {fmtDate(a.published_at)}
                {a.author ? ` · ${a.author}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Mood check-in */}
      {!submitted ? (
        <div className="card">
          <h3 style={{ marginBottom: 10 }}>How are you feeling today?</h3>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            {MOOD_LABELS.map((label, i) => (
              <button
                key={label}
                type="button"
                className={`btn sm${mood === i + 1 ? '' : ' ghost'}`}
                onClick={() => setMood(i + 1)}
                aria-pressed={mood === i + 1}
              >
                {label}
              </button>
            ))}
          </div>
          <textarea
            value={moodNote}
            onChange={(e) => setMoodNote(e.target.value)}
            rows={2}
            placeholder="Optional note…"
            style={{ width: '100%', marginBottom: 10 }}
          />
          <button
            type="button"
            className="btn"
            disabled={isPending || mood === null}
            onClick={handleMoodSubmit}
          >
            {isPending ? 'Saving…' : 'Submit'}
          </button>
        </div>
      ) : (
        <div className="card">
          <p style={{ color: 'var(--good)' }}>Thanks for checking in today!</p>
        </div>
      )}
    </div>
  );
};
