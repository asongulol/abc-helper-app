'use client';

import { useId, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import type { MiscItem } from '@/lib/pay/calc';

export type MiscModalPayload = {
  haPhp: number;
  t13Php: number | null; // null = revert to computed
  pddPhp: number;
  bonusPhp: number;
  miscItems: MiscItem[];
};

interface MiscModalProps {
  name: string;
  ratePhp: number | null;
  haPhp: number;
  t13Php: number;
  computedT13Php: number;
  pddPhp: number;
  bonusPhp: number;
  miscItems: readonly MiscItem[];
  onSave: (payload: MiscModalPayload) => void;
  onClose: () => void;
}

type EarnRow = { label: string; amount: string };
type HoursRow = { label: string; hours: string; hourlyRate: number };
type DedRow = { label: string; amount: string };

const numInp: React.CSSProperties = {
  width: 120,
  padding: '4px 6px',
  fontSize: 13,
};
const lblInp: React.CSSProperties = {
  flex: 1,
  padding: '4px 6px',
  fontSize: 13,
  minWidth: 160,
};
const sectionStyle: React.CSSProperties = {
  borderTop: '1px solid var(--border)',
  paddingTop: 10,
  marginTop: 10,
};

export const MiscModal = ({
  name,
  ratePhp,
  haPhp,
  t13Php,
  computedT13Php,
  pddPhp,
  bonusPhp,
  miscItems,
  onSave,
  onClose,
}: MiscModalProps) => {
  const idHa = useId();
  const idT13 = useId();
  const idPdd = useId();
  const idBonus = useId();

  // effective hourly rate: (semi-monthly rate × 24) ÷ 2080 (legacy formula)
  const rate = Number(ratePhp) || 0;
  const hourlyRate = rate > 0 ? +((rate * 24) / 2080).toFixed(4) : 0;

  const [ha, setHa] = useState(haPhp ? String(haPhp) : '');
  const [t13, setT13] = useState(t13Php ? String(t13Php) : '');
  const [pdd, setPdd] = useState(pddPhp ? String(pddPhp) : '');
  const [bonus, setBonus] = useState(bonusPhp ? String(bonusPhp) : '');

  const seedItems = Array.isArray(miscItems) ? miscItems : [];
  const [earns, setEarns] = useState<EarnRow[]>(() =>
    seedItems
      .filter((x) => x.kind === 'other_earns')
      .map((x) => ({ label: x.label ?? '', amount: String(x.amount ?? '') })),
  );
  const [hrs, setHrs] = useState<HoursRow[]>(() =>
    seedItems
      .filter((x) => x.kind === 'other_hours')
      .map((x) => ({
        label: x.label ?? '',
        hours: String(x.hours ?? ''),
        hourlyRate: Number(
          x.hours != null && x.amount != null && Number(x.hours) > 0
            ? (Number(x.amount) / Number(x.hours)).toFixed(4)
            : hourlyRate,
        ),
      })),
  );
  const [deds, setDeds] = useState<DedRow[]>(() =>
    seedItems
      .filter((x) => x.kind === 'deduction')
      .map((x) => ({ label: x.label ?? '', amount: String(x.amount ?? '') })),
  );

  const setEarn = (i: number, patch: Partial<EarnRow>) =>
    setEarns((prev) => prev.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const setHr = (i: number, patch: Partial<HoursRow>) =>
    setHrs((prev) => prev.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const setDed = (i: number, patch: Partial<DedRow>) =>
    setDeds((prev) => prev.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  const hoursAmount = (e: HoursRow) =>
    +((Number(e.hours) || 0) * (Number(e.hourlyRate) || 0)).toFixed(2);

  const haNum = Number(ha) || 0;
  const t13Num = t13 === '' || t13 == null ? computedT13Php : Number(t13) || 0;
  const pddNum = Number(pdd) || 0;
  const bonusNum = Number(bonus) || 0;
  const earnsSum = earns.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const hoursSum = hrs.reduce((s, e) => s + hoursAmount(e), 0);
  const dedsSum = deds.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const netImpact = haNum + t13Num + pddNum + bonusNum + earnsSum + hoursSum - dedsSum;

  const handleSave = () => {
    const cleanEarns = earns
      .map((e) => ({ label: e.label.trim(), amount: Number(e.amount) || 0 }))
      .filter((e) => e.label && e.amount > 0);
    const cleanHours = hrs
      .map((e) => ({
        label: e.label.trim(),
        hours: Number(e.hours) || 0,
        hourlyRate: Number(e.hourlyRate) || hourlyRate,
      }))
      .filter((e) => e.label && e.hours > 0)
      .map((e) => ({ ...e, amount: +(e.hours * e.hourlyRate).toFixed(2) }));
    const cleanDeds = deds
      .map((e) => ({ label: e.label.trim(), amount: Number(e.amount) || 0 }))
      .filter((e) => e.label && e.amount > 0);

    const newMiscItems: MiscItem[] = [
      ...cleanEarns.map((e) => ({
        kind: 'other_earns' as const,
        label: e.label,
        amount: +e.amount.toFixed(2),
      })),
      ...cleanHours.map((e) => ({
        kind: 'other_hours' as const,
        label: e.label,
        hours: e.hours,
        amount: e.amount,
      })),
      ...cleanDeds.map((e) => ({
        kind: 'deduction' as const,
        label: e.label,
        amount: +e.amount.toFixed(2),
      })),
    ];

    onSave({
      haPhp: haNum,
      t13Php: t13 === '' || t13 == null ? null : t13Num,
      pddPhp: pddNum,
      bonusPhp: bonusNum,
      miscItems: newMiscItems,
    });
  };

  return (
    <Modal title={`Misc · ${name}`} onClose={onClose} maxWidth={640}>
      <p className="sub" style={{ marginTop: 2, fontSize: 12 }}>
        Rate ₱{rate.toLocaleString()} · effective hourly ₱
        {hourlyRate.toLocaleString('en-US', { minimumFractionDigits: 2 })} (rate×24÷2080)
      </p>

      <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
        <div className="field">
          <label htmlFor={idHa}>Health Allowance (₱)</label>
          <input
            id={idHa}
            type="number"
            step="0.01"
            value={ha}
            onChange={(e) => setHa(e.target.value)}
            placeholder="0"
            style={numInp}
          />
        </div>
        <div className="field">
          <label htmlFor={idT13}>
            13th month (₱){' '}
            <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>
              {t13 === '' || t13 == null
                ? `(computed: ₱${computedT13Php.toLocaleString('en-US', { minimumFractionDigits: 2 })})`
                : ''}
            </span>
          </label>
          <input
            id={idT13}
            type="number"
            step="0.01"
            value={t13}
            onChange={(e) => setT13(e.target.value)}
            placeholder={`computed ${computedT13Php.toFixed(2)}`}
            style={numInp}
          />
        </div>
        <div className="field">
          <label htmlFor={idPdd}>Lunch (₱)</label>
          <input
            id={idPdd}
            type="number"
            step="0.01"
            value={pdd}
            onChange={(e) => setPdd(e.target.value)}
            placeholder="0"
            style={numInp}
          />
        </div>
        <div className="field">
          <label htmlFor={idBonus}>Bonus (₱)</label>
          <input
            id={idBonus}
            type="number"
            step="0.01"
            value={bonus}
            onChange={(e) => setBonus(e.target.value)}
            placeholder="0"
            style={numInp}
          />
        </div>
      </div>

      {/* Other Earns */}
      <div style={sectionStyle}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '.03em',
            }}
          >
            Other earns
          </span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setEarns((prev) => [...prev, { label: '', amount: '' }])}
          >
            + Add earn
          </button>
        </div>
        {earns.length === 0 ? (
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
            None.
          </p>
        ) : (
          earns.map((e, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: editable list, no stable id
              key={`earn-${i}`}
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                marginTop: 6,
                flexWrap: 'wrap',
              }}
            >
              <input
                type="text"
                placeholder="Description (required)"
                value={e.label}
                onChange={(ev) => setEarn(i, { label: ev.target.value })}
                style={lblInp}
              />
              <input
                type="number"
                step="0.01"
                placeholder="₱ amount"
                value={e.amount}
                onChange={(ev) => setEarn(i, { amount: ev.target.value })}
                style={numInp}
              />
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setEarns((prev) => prev.filter((_, j) => j !== i))}
                style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      {/* Other Hours */}
      <div style={sectionStyle}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '.03em',
            }}
          >
            Other hours{' '}
            <span style={{ textTransform: 'none' }}>
              (₱
              {hourlyRate.toLocaleString('en-US', { minimumFractionDigits: 2 })}
              /h)
            </span>
          </span>
          <button
            type="button"
            className="btn ghost sm"
            disabled={hourlyRate <= 0}
            title={hourlyRate <= 0 ? 'Set a rate first' : 'Add a labeled hours entry'}
            onClick={() => setHrs((prev) => [...prev, { label: '', hours: '', hourlyRate }])}
          >
            + Add hours
          </button>
        </div>
        {hrs.length === 0 ? (
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
            None.
          </p>
        ) : (
          hrs.map((e, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: editable list, no stable id
              key={`hr-${i}`}
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                marginTop: 6,
                flexWrap: 'wrap',
              }}
            >
              <input
                type="text"
                placeholder="Description (required)"
                value={e.label}
                onChange={(ev) => setHr(i, { label: ev.target.value })}
                style={lblInp}
              />
              <input
                type="number"
                step="0.01"
                placeholder="hours"
                value={e.hours}
                onChange={(ev) => setHr(i, { hours: ev.target.value })}
                style={{ width: 90, padding: '4px 6px', fontSize: 13 }}
              />
              <span className="muted" style={{ fontSize: 12 }}>
                × ₱
                {Number(e.hourlyRate).toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                })}
                /h ={' '}
                <b>
                  ₱
                  {hoursAmount(e).toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                  })}
                </b>
              </span>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setHrs((prev) => prev.filter((_, j) => j !== i))}
                style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      {/* Deductions */}
      <div style={sectionStyle}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '.03em',
            }}
          >
            Deductions <span style={{ textTransform: 'none' }}>(subtracted from Net)</span>
          </span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setDeds((prev) => [...prev, { label: '', amount: '' }])}
          >
            + Add deduction
          </button>
        </div>
        {deds.length === 0 ? (
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
            None.
          </p>
        ) : (
          deds.map((e, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: editable list, no stable id
              key={`ded-${i}`}
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                marginTop: 6,
                flexWrap: 'wrap',
              }}
            >
              <input
                type="text"
                placeholder="Reason (required)"
                value={e.label}
                onChange={(ev) => setDed(i, { label: ev.target.value })}
                style={lblInp}
              />
              <input
                type="number"
                step="0.01"
                placeholder="₱ amount"
                value={e.amount}
                onChange={(ev) => setDed(i, { amount: ev.target.value })}
                style={numInp}
              />
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setDeds((prev) => prev.filter((_, j) => j !== i))}
                style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      <div
        className="actions"
        style={{
          ...sectionStyle,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div style={{ fontSize: 13 }}>
          Net impact:{' '}
          <b style={{ color: netImpact < 0 ? '#b91c1c' : '#166534' }}>
            {netImpact < 0 ? '-' : '+'}₱
            {Math.abs(netImpact).toLocaleString('en-US', {
              minimumFractionDigits: 2,
            })}
          </b>
        </div>
        <div>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>{' '}
          <button type="button" className="btn" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
};
