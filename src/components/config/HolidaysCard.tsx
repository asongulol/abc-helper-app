'use client';

import { useEffect, useId, useReducer, useRef } from 'react';
import { fmtDate } from '@/lib/format';
import type { Holiday } from '@/lib/pay/holidays';
import { defaultHolidays, observedDate } from '@/lib/pay/holidays';

/** localStorage key must match the legacy app's `holidays_<year>`. */
const storageKey = (year: number) => `holidays_${year}`;

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

interface State {
  year: number;
  holidays: Holiday[];
  dirty: boolean;
}

type Action =
  | { type: 'set_year'; year: number }
  | { type: 'load'; holidays: Holiday[] }
  | { type: 'add'; holiday: Holiday }
  | { type: 'remove'; date: string }
  | { type: 'update_name'; date: string; name: string }
  | { type: 'reset' };

const sortByDate = (hs: Holiday[]): Holiday[] =>
  [...hs].sort((a, b) => a.date.localeCompare(b.date));

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'set_year':
      return { ...state, year: action.year, dirty: false };
    case 'load':
      return { ...state, holidays: sortByDate(action.holidays), dirty: false };
    case 'add': {
      if (state.holidays.some((h) => h.date === action.holiday.date)) return state;
      return {
        ...state,
        holidays: sortByDate([...state.holidays, action.holiday]),
        dirty: true,
      };
    }
    case 'remove':
      return {
        ...state,
        holidays: state.holidays.filter((h) => h.date !== action.date),
        dirty: true,
      };
    case 'update_name':
      return {
        ...state,
        holidays: state.holidays.map((h) =>
          h.date === action.date ? { ...h, name: action.name } : h,
        ),
        dirty: true,
      };
    case 'reset':
      return {
        ...state,
        holidays: sortByDate(defaultHolidays(state.year)),
        dirty: true,
      };
    default:
      return state;
  }
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Observed-holidays editor — the "Observed Holidays" row of the Configuration
 * launcher (rendered inside that panel's Modal, so it owns no heading of its own).
 *
 * Persists to localStorage key `holidays_<year>` exactly like the legacy app.
 * Defaults come from `defaultHolidays(year)`, already shifted to the observed
 * working day; a custom holiday that lands on a weekend shows its observed day
 * inline. Client-only — no server round-trip.
 */
export const HolidaysCard = () => {
  const currentYear = new Date().getFullYear();
  const [state, dispatch] = useReducer(reducer, {
    year: currentYear,
    holidays: [],
    dirty: false,
  });

  const addDateId = useId();
  const addNameId = useId();
  const addDateRef = useRef<HTMLInputElement>(null);
  const addNameRef = useRef<HTMLInputElement>(null);

  // Load from localStorage whenever the year changes (client-only effect).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey(state.year));
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          dispatch({ type: 'load', holidays: parsed as Holiday[] });
          return;
        }
      }
    } catch {
      /* malformed — fall through to defaults */
    }
    dispatch({ type: 'load', holidays: defaultHolidays(state.year) });
  }, [state.year]);

  // Persist to localStorage whenever holidays change and are dirty.
  useEffect(() => {
    if (!state.dirty) return;
    try {
      localStorage.setItem(storageKey(state.year), JSON.stringify(state.holidays));
    } catch {
      /* storage full or unavailable */
    }
  }, [state.holidays, state.year, state.dirty]);

  const handleAdd = () => {
    const date = addDateRef.current?.value ?? '';
    const name = addNameRef.current?.value?.trim() ?? '';
    if (!date || !name) return;
    dispatch({ type: 'add', holiday: { date, name } });
    if (addDateRef.current) addDateRef.current.value = '';
    if (addNameRef.current) addNameRef.current.value = '';
  };

  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - 1 + i);

  return (
    <div>
      <p className="sub">
        Holidays reduce expected working hours by one day per occurrence (8h FT / 4h PT). A holiday
        landing on a weekend is observed on the closest working day — Saturday → the Friday before,
        Sunday → the Monday after. Stored in your browser — changes are local to this device.
      </p>

      <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
        <label style={{ fontSize: 13, fontWeight: 600 }}>
          Year:{' '}
          <select
            value={state.year}
            onChange={(e) => dispatch({ type: 'set_year', year: Number(e.target.value) })}
            style={{ marginLeft: 6 }}
            aria-label="Select year"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => dispatch({ type: 'reset' })}
          title="Reset to default holidays for this year"
        >
          Reset to defaults
        </button>
      </div>

      {state.holidays.length === 0 ? (
        <p className="muted" style={{ textAlign: 'center', padding: '20px 0' }}>
          No holidays defined for {state.year}.
        </p>
      ) : (
        <div className="table-scroll" style={{ marginBottom: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Name</th>
                <th style={{ width: 80 }}>Remove</th>
              </tr>
            </thead>
            <tbody>
              {state.holidays.map((h) => (
                <tr key={h.date}>
                  <td data-label="Date">
                    <code style={{ fontSize: 12 }}>{h.date}</code>
                    <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                      {fmtDate(h.date)}
                    </span>
                    {observedDate(h.date) !== h.date && (
                      <span
                        className="muted"
                        style={{ fontSize: 11, marginLeft: 6, fontStyle: 'italic' }}
                        title="Falls on a weekend — counted on the closest working day"
                      >
                        → observed {fmtDate(observedDate(h.date))}
                      </span>
                    )}
                  </td>
                  <td data-label="Name">
                    <input
                      value={h.name}
                      onChange={(e) =>
                        dispatch({
                          type: 'update_name',
                          date: h.date,
                          name: e.target.value,
                        })
                      }
                      aria-label={`Holiday name for ${h.date}`}
                      style={{ width: '100%', minWidth: 180 }}
                    />
                  </td>
                  <td data-label="Remove" className="card-action">
                    <button
                      type="button"
                      className="btn danger-outline sm"
                      onClick={() => dispatch({ type: 'remove', date: h.date })}
                      aria-label={`Remove ${h.name}`}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="actionbar" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
        <strong style={{ marginBottom: 8 }}>Add holiday</strong>
        <div className="row">
          <div className="field" style={{ minWidth: 160 }}>
            <label htmlFor={addDateId}>Date</label>
            <input
              id={addDateId}
              ref={addDateRef}
              type="date"
              aria-label="Holiday date"
              min={`${state.year}-01-01`}
              max={`${state.year}-12-31`}
            />
          </div>
          <div className="field" style={{ minWidth: 220 }}>
            <label htmlFor={addNameId}>Name</label>
            <input
              id={addNameId}
              ref={addNameRef}
              type="text"
              placeholder="e.g. Company Outing"
              aria-label="Holiday name"
            />
          </div>
        </div>
        <button type="button" className="btn" onClick={handleAdd}>
          Add holiday
        </button>
      </div>

      {state.dirty && (
        <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          Changes saved to this browser automatically.
        </p>
      )}
    </div>
  );
};
