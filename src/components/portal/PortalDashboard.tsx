'use client';

import { useEffect, useState } from 'react';
import { DocReminderOverlay } from './DocReminderOverlay';
import { FromNewYork, nyHourNow, skyPhase } from './FromNewYork';
import { type HomePay, PortalPayActivity } from './PortalPayActivity';
import { ToolsPopup } from './ToolsPopup';

interface Announcement {
  id: string;
  title: string;
  body: string | null;
  published_at: string;
  author: string | null;
}

interface Props {
  greetName: string;
  onboarded: boolean;
  announcements: Announcement[];
  homePay: HomePay;
  activity: { date: string; activity: number }[];
  pendingDocs: string[];
  toolsPending: boolean;
}

const TOOLKIT = [
  {
    label: 'Hubstaff',
    sub: 'Track your time',
    icon: '⏱️',
    domain: 'hubstaff.com',
    href: 'https://app.hubstaff.com',
  },
  {
    label: 'Gmail',
    sub: 'Work email',
    icon: '✉️',
    domain: 'gmail.com',
    href: 'https://mail.google.com',
  },
  {
    label: 'Providersoft',
    sub: 'Provider system',
    icon: '🩺',
    domain: 'web.providersoftllc.com',
    href: 'https://web.providersoftllc.com/AbilityBuilders/security/login.aspx',
  },
  { label: 'Wise', sub: 'Get paid', icon: '💸', domain: 'wise.com', href: 'https://wise.com/home' },
];

/**
 * Tool tile icon — shows the tool's real favicon (legacy `Favicon`): DuckDuckGo's
 * icon service first, then Google's, falling back to the emoji if both fail.
 */
const ToolIcon = ({ domain, emoji }: { domain: string; emoji: string }) => {
  const [stage, setStage] = useState(0);
  const src = [
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
  ][stage];
  if (!src) {
    return (
      <span className="qico" aria-hidden="true">
        {emoji}
      </span>
    );
  }
  return (
    <img
      className="qico"
      src={src}
      alt=""
      width={24}
      height={24}
      loading="lazy"
      onError={() => setStage((s) => s + 1)}
      style={{ objectFit: 'contain' }}
    />
  );
};

export const PortalDashboard = ({
  greetName,
  announcements,
  homePay,
  activity,
  pendingDocs,
  toolsPending,
}: Props) => {
  const [mounted, setMounted] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    setMounted(true);
    const id = setInterval(() => tick((t) => t + 1), 60000);
    return () => clearInterval(id);
  }, []);

  const phHour = mounted
    ? Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Manila',
          hour: 'numeric',
          hour12: false,
        }).format(new Date()),
      )
    : 9;
  const clock = mounted
    ? new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Manila',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date())
    : '';
  const greetTL =
    phHour < 12 ? 'Magandang umaga' : phHour < 18 ? 'Magandang hapon' : 'Magandang gabi';
  const nyPh = skyPhase(mounted ? nyHourNow() : 9);
  const greetEmoji = nyPh.night ? '🌙' : '☀️';
  const initials =
    (greetName || '?')
      .trim()
      .split(/\s+/)
      .map((s) => s[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?';

  return (
    <div className="wrap home">
      <ToolsPopup pending={toolsPending} />
      <DocReminderOverlay docs={pendingDocs} />

      {/* PHT clock + Kumusta greeting */}
      <div style={{ margin: '8px 2px 2px', fontSize: 13, color: 'var(--muted)' }}>
        {clock ? `${clock} · PHT` : ' '}
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '6px 2px 2px' }}>
        <div className="avatar">{initials}</div>
        <div>
          <h2 style={{ margin: 0, fontSize: 19 }}>
            {greetTL}
            {greetName ? `, ${greetName}` : ''} {greetEmoji}
          </h2>
          <div className="sub" style={{ margin: '1px 0 0' }}>
            {nyPh.sign}
          </div>
        </div>
      </div>

      <FromNewYork />

      {/* Word from Your Mother (announcements) */}
      <div className="dash-cell dash-word">
        <div className="stickwrap">
          <span className="sticker">📣 Word from Your Mother</span>
        </div>
        {announcements.length === 0 ? (
          <div className="empty">No announcements right now.</div>
        ) : (
          <div className="card annlist">
            {announcements.map((a) => (
              <div className="item" key={a.id}>
                <div style={{ fontWeight: 700 }}>
                  <span className="dot">•</span>
                  {a.title}
                </div>
                <div className="sub" style={{ margin: '1px 0 3px' }}>
                  {String(a.published_at).slice(0, 10)}
                </div>
                {a.body && <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{a.body}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Your pay + Activity */}
      <PortalPayActivity pay={homePay} activity={activity} />

      {/* Toolkit */}
      <div className="dash-cell">
        <div className="stickwrap">
          <span className="sticker">🧰 Your toolkit</span>
        </div>
        <div className="card">
          <div className="qgrid">
            {TOOLKIT.map((t) => (
              <a key={t.label} href={t.href} target="_blank" rel="noreferrer">
                <ToolIcon domain={t.domain} emoji={t.icon} />
                <div>
                  <div style={{ fontWeight: 600 }}>{t.label}</div>
                  <div className="sub" style={{ fontSize: 11 }}>
                    {t.sub}
                  </div>
                </div>
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
