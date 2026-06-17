'use client';

import { useEffect, useState } from 'react';

/**
 * "From New York" hero — faithful port of the legacy portal NyPanel. Live
 * two-zone clocks (PHT + NYT, re-rendered every 20s) over a sky that matches
 * New York's real time of day, animated open-meteo weather FX, a lit-window
 * skyline at dusk/night, the Liberty torch + Milo the bodega cat narrating the
 * daily NYC fact. Everything time/weather-based is resolved after mount to
 * avoid SSR hydration mismatch.
 */

const WCODE: Record<number, [string, string]> = {
  0: ['Clear', '☀️'],
  1: ['Mainly clear', '🌤️'],
  2: ['Partly cloudy', '⛅'],
  3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'],
  48: ['Fog', '🌫️'],
  51: ['Light drizzle', '🌦️'],
  53: ['Drizzle', '🌦️'],
  55: ['Drizzle', '🌦️'],
  61: ['Light rain', '🌧️'],
  63: ['Rain', '🌧️'],
  65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'],
  67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'],
  73: ['Snow', '🌨️'],
  75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'],
  80: ['Showers', '🌦️'],
  81: ['Showers', '🌦️'],
  82: ['Heavy showers', '⛈️'],
  85: ['Snow showers', '🌨️'],
  86: ['Snow showers', '🌨️'],
  95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm', '⛈️'],
  99: ['Thunderstorm', '⛈️'],
};

const NYC_TRIVIA = [
  'The NYC subway has 472 stations — more than any other system in the world.',
  'Times Square is named after The New York Times, which moved there in 1904.',
  'Over 800 languages are spoken in NYC — the most linguistically diverse city on Earth.',
  'Central Park is larger than the entire principality of Monaco.',
  "A 'bodega' is a NYC corner store — many have a beloved resident 'bodega cat.'",
  'The Statue of Liberty was a gift from France, dedicated in 1886.',
  "New Yorkers say they take 'the train,' never 'the metro.'",
  'George Washington took the first presidential oath at Federal Hall on Wall Street in 1789.',
  "The Brooklyn Bridge (1883) was the world's first steel-wire suspension bridge.",
  "'Schmear' — the cream cheese on your bagel — comes from Yiddish, a big influence on NYC slang.",
  'Locals fold a pizza slice in half to eat it on the go.',
  'The Empire State Building has its own ZIP code: 10118.',
  "A 'stoop' is the front steps of a building; 'stoop-sitting' is a summer ritual.",
  'Grand Central Terminal has 44 platforms — the most of any train station in the world.',
  "Manhattan's numbered street grid was laid out in the Commissioners' Plan of 1811.",
  'Cabs are yellow because that hue is the easiest to spot from a distance.',
  'The High Line park was built on a disused elevated freight railway.',
  "'Fuhgeddaboudit' is famous enough to appear on a road sign leaving Brooklyn.",
  "NYC's five boroughs are Manhattan, Brooklyn, Queens, the Bronx, and Staten Island.",
  "The nickname 'The Big Apple' spread from 1920s horse-racing slang.",
];

interface SkyPhase {
  grad: string;
  night: boolean;
  sign: string;
}

export function nyHourNow(): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    }).format(new Date()),
  );
}

export function skyPhase(h: number): SkyPhase {
  if (h >= 5 && h < 7)
    return {
      grad: 'linear-gradient(180deg,#2a3a6b,#6b5a8c 55%,#1F3A68)',
      night: false,
      sign: 'New York is waking up.',
    };
  if (h >= 7 && h < 17)
    return {
      grad: 'linear-gradient(180deg,#2f5aa0,#5b8fd4 55%,#1F3A68)',
      night: false,
      sign: "It's a fresh day over in New York.",
    };
  if (h >= 17 && h < 19)
    return {
      grad: 'linear-gradient(180deg,#4a3f7a,#b5703e 55%,#1F3A68)',
      night: false,
      sign: 'Golden hour in the city right now.',
    };
  if (h >= 19 && h < 21)
    return {
      grad: 'linear-gradient(180deg,#21305c,#3d3566 55%,#8a4a52)',
      night: true,
      sign: 'New York is settling into the evening.',
    };
  return {
    grad: 'linear-gradient(180deg,#14213d,#1F3A68 62%,#24305a)',
    night: true,
    sign: 'New York is winding down for the night.',
  };
}

function wxCategory(code: number | null): string | null {
  if (code == null) return null;
  if ([45, 48].includes(code)) return 'fog';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ([95, 96, 99].includes(code)) return 'storm';
  if ([51, 53, 55, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rain';
  if ([2, 3].includes(code)) return 'cloudy';
  if ([0, 1].includes(code)) return 'clear';
  return null;
}

const WIN: [number, number, number][] = [
  [38, 46, 0.1],
  [90, 40, 0.25],
  [90, 48, 0.4],
  [112, 52, 0.55],
  [138, 32, 0.7],
  [138, 42, 0.85],
  [210, 38, 1],
  [232, 50, 1.15],
  [255, 28, 1.3],
  [255, 38, 1.45],
  [272, 44, 1.6],
  [324, 40, 1.75],
  [344, 52, 1.9],
];

export const FromNewYork = () => {
  const [mounted, setMounted] = useState(false);
  const [, tick] = useState(0);
  const [wx, setWx] = useState<{
    temperature_2m: number;
    weather_code: number;
  } | null>(null);

  useEffect(() => {
    setMounted(true);
    const id = setInterval(() => tick((t) => t + 1), 20000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    fetch(
      'https://api.open-meteo.com/v1/forecast?latitude=40.7128&longitude=-74.006&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=America%2FNew_York',
    )
      .then((r) => r.json())
      .then((d) => {
        if (d?.current) setWx(d.current);
      })
      .catch(() => {});
  }, []);

  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date());
  const day = (tz: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(new Date());

  const ph = skyPhase(mounted ? nyHourNow() : 9);
  const ds = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [yy, mm, dd] = ds.split('-').map(Number);
  const doy = Math.floor(
    (Date.UTC(yy ?? 2026, (mm ?? 1) - 1, dd ?? 1) - Date.UTC(yy ?? 2026, 0, 1)) / 86400000,
  );
  const fact = NYC_TRIVIA[doy % NYC_TRIVIA.length];
  const [, wicon] = (wx && WCODE[wx.weather_code]) || ['', ''];
  const wxStr = wx ? ` · ${wicon || '🌡️'} ${Math.round(wx.temperature_2m)}°F` : '';
  const wxcat = wx ? wxCategory(wx.weather_code) : null;

  return (
    <div className="nyhero" style={{ background: ph.grad }}>
      {wxcat && <div className={`wxfx wxfx-${wxcat}`} aria-hidden="true" />}
      <div className="eyebrow">🗽 From New York</div>
      <svg className="celestial" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
        {ph.night ? (
          <g>
            <circle cx="15" cy="15" r="9" fill="#D4A24C" />
            <circle cx="19" cy="13" r="8" fill="#1b2c4f" />
          </g>
        ) : (
          <g>
            <circle cx="15" cy="15" r="13" fill="#F4C95D" opacity="0.18" />
            <circle cx="15" cy="15" r="8" fill="#F4C95D" />
          </g>
        )}
      </svg>
      <div className="zones">
        <div className="z">
          <div className="lbl">🇵🇭 Manila</div>
          <div className="t">{mounted ? fmt('Asia/Manila') : '—'}</div>
          <div className="d">{mounted ? day('Asia/Manila') : ''}</div>
        </div>
        <div className="vline" />
        <div className="z">
          <div className="lbl">🗽 New York</div>
          <div className="t">{mounted ? fmt('America/New_York') : '—'}</div>
          <div className="d">{mounted ? `${day('America/New_York')}${wxStr}` : ''}</div>
        </div>
      </div>
      <div className="ghr" />
      <div className="fact">
        <b>Milo says:</b> {fact}
      </div>
      <svg className="sky" viewBox="0 0 400 74" preserveAspectRatio="none" aria-hidden="true">
        {ph.night && (
          <g fill="#fff">
            <circle cx="40" cy="10" r="1" opacity="0.7" />
            <circle cx="120" cy="7" r="1" opacity="0.5" />
            <circle cx="300" cy="8" r="1" opacity="0.55" />
            <circle cx="360" cy="13" r="1" opacity="0.7" />
          </g>
        )}
        <g fill="#0c1730" opacity="0.85">
          <rect x="0" y="50" width="30" height="24" />
          <rect x="32" y="40" width="22" height="34" />
          <rect x="56" y="54" width="26" height="20" />
          <rect x="84" y="32" width="18" height="42" />
          <rect x="104" y="46" width="28" height="28" />
          <rect x="134" y="24" width="12" height="50" />
          <rect x="148" y="36" width="26" height="38" />
          <rect x="176" y="52" width="30" height="22" />
          <rect x="206" y="30" width="16" height="44" />
          <rect x="224" y="42" width="26" height="32" />
          <rect x="252" y="20" width="10" height="54" />
          <rect x="264" y="36" width="22" height="38" />
          <rect x="288" y="48" width="28" height="26" />
          <rect x="318" y="32" width="16" height="42" />
          <rect x="336" y="44" width="26" height="30" />
          <rect x="364" y="54" width="20" height="20" />
        </g>
        {ph.night && (
          <g fill="#D4A24C">
            {WIN.map((p) => (
              <rect
                key={`${p[0]}-${p[1]}`}
                className="win"
                style={{ animationDelay: `${p[2]}s` }}
                x={p[0]}
                y={p[1]}
                width="2"
                height="3"
              />
            ))}
          </g>
        )}
        <g transform="translate(392,26)">
          <rect x="-2" y="6" width="4" height="46" fill="#0c1730" />
          <ellipse cx="0" cy="3" rx="6" ry="3.5" fill="#0c1730" />
          <path d="M0 -10 L4 1 L-4 1 Z" fill="#D4A24C" />
          <circle cx="0" cy="-11" r="2.6" fill="#ffd98a" />
        </g>
        <g transform="translate(140,16)">
          <ellipse cx="0" cy="9" rx="8" ry="6" fill="#EAEFF7" />
          <path d="M-6 5 L-8 -2 L-2 3 Z" fill="#EAEFF7" />
          <path d="M6 5 L8 -2 L2 3 Z" fill="#EAEFF7" />
          <path
            d="M8 10 q6 -1 5 -8"
            stroke="#EAEFF7"
            strokeWidth="2.6"
            fill="none"
            strokeLinecap="round"
          />
          <circle cx="-2.5" cy="7.5" r="1" fill="#16264A" />
          <circle cx="2.5" cy="7.5" r="1" fill="#16264A" />
          <rect x="-4.5" y="12" width="9" height="1.8" rx="1" fill="#D4A24C" />
        </g>
      </svg>
    </div>
  );
};
