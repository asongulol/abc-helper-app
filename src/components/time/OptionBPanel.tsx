'use client';

/**
 * Option B — sync from Hubstaff API.
 *
 * Faithful port of the legacy Time Import "Option B" panel
 * (app/index.html ~4784-4808): an Organization dropdown, a
 * "List my orgs" / "↻ Orgs" toggle button, Start and "Stop (auto)" date
 * inputs, and an "Import Time" button.
 *
 * On a chosen Start date the Stop field auto-fills to the semi-monthly period
 * end (15th or month-end) — still editable. The sync commits straight to the
 * Time Approval table (pending); there is no preview for the API path.
 */

import { useEffect, useState, useTransition } from 'react';
import { useToast } from '@/components/ui';
import type { PayPeriod } from '@/lib/dates/periods';
import { periodFor } from '@/lib/dates/periods';
import type { HubstaffOrg } from '@/server/actions/hubstaff-sync';
import {
  getDefaultHubstaffOrgId,
  importHubstaffTime,
  listHubstaffOrgs,
} from '@/server/actions/hubstaff-sync';

interface OptionBPanelProps {
  companyId: string;
  /** Window to pull — the next unimported period, resolved server-side. */
  period: PayPeriod;
  /** Called on a successful import to refresh the approval table. */
  onImported: () => void;
}

export const OptionBPanel = ({ companyId, period, onImported }: OptionBPanelProps) => {
  const { notify } = useToast();
  const [orgId, setOrgId] = useState('');
  const [syncStart, setSyncStart] = useState(period.start);
  const [syncStop, setSyncStop] = useState(period.end);
  // null = unloaded, [] = loaded (zero orgs), [...] = loaded.
  const [orgs, setOrgs] = useState<HubstaffOrg[] | null>(null);
  const [loadingOrgs, startListing] = useTransition();
  const [syncing, startSync] = useTransition();

  // Default to the org the sync actually uses (companies.hubstaff_org_id —
  // Aaron Anderson E.H.S. LLC), so Import Time works without listing orgs first.
  useEffect(() => {
    let alive = true;
    void getDefaultHubstaffOrgId(companyId).then((id) => {
      if (alive && id != null) setOrgId((cur) => cur || String(id));
    });
    return () => {
      alive = false;
    };
  }, [companyId]);

  const listOrgs = () => {
    startListing(async () => {
      const res = await listHubstaffOrgs();
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      const list = res.data.organizations;
      setOrgs(list);
      if (list.length === 1) setOrgId(String(list[0]?.id ?? ''));
    });
  };

  const syncFromHubstaff = () => {
    if (!orgId || !syncStart || !syncStop) {
      notify('Enter Hubstaff org id, start and stop dates.', { type: 'error' });
      return;
    }
    startSync(async () => {
      const res = await importHubstaffTime({
        companyId,
        orgId,
        start: syncStart,
        stop: syncStop,
      });
      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }
      const { rowsWritten, membersSeen, unmatched, droppedAfterEnd } = res.data;
      if (rowsWritten === 0 && membersSeen === 0) {
        notify(`Hubstaff returned no activity for ${syncStart} → ${syncStop}.`, { type: 'info' });
        return;
      }
      // The sync protects already-decided days and only logged it, so a
      // 4h → 8h change on an approved day read as "Synced 0 entries" (RP-36).
      // ponytail: counted loosely — the server half may report a count or the
      // divergence list itself.
      const extra = res.data as unknown as { divergences?: unknown; skippedDecided?: unknown };
      const asCount = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0);
      const divergences = asCount(extra.divergences);
      const skippedDecided = asCount(extra.skippedDecided);

      const unmatchedNote =
        unmatched.length > 0
          ? ` ${unmatched.length} member(s) couldn't be matched to a contractor and were skipped.`
          : '';
      const decidedNote =
        skippedDecided > 0
          ? ` ${skippedDecided} already approved/rejected day(s) were left untouched.`
          : '';
      // Hubstaff keeps reporting a departed member's days — say so, or the
      // hours look like they simply went missing.
      const endedNote =
        droppedAfterEnd > 0
          ? ` ${droppedAfterEnd} day(s) fell after a contractor's last day and were not imported.`
          : '';
      const divergenceNote =
        divergences > 0
          ? ` ⚠ ${divergences} of them now report DIFFERENT hours in Hubstaff — the approved value was kept. Check the audit log (time_divergence) and re-approve if the new number is right.`
          : '';
      notify(
        `Synced ${rowsWritten} daily entr${rowsWritten === 1 ? 'y' : 'ies'} for ${membersSeen} member(s).${unmatchedNote}${decidedNote}${endedNote}${divergenceNote}`,
        {
          type: divergences > 0 ? 'warn' : rowsWritten > 0 ? 'success' : 'info',
          persistent: unmatched.length > 0 || divergences > 0 || droppedAfterEnd > 0,
        },
      );
      onImported();
    });
  };

  return (
    <div style={{ borderLeft: '1px solid var(--border)', paddingLeft: 16 }}>
      <span className="section-label">Option B — sync from Hubstaff API</span>
      <p className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
        Pulls directly. Needs the <code>hubstaff-sync</code> Edge Function deployed and the token
        set (see setup).
      </p>
      <div
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          alignItems: 'flex-end',
        }}
      >
        <div>
          <span style={{ fontSize: 10, color: 'var(--muted)' }}>Organization</span>
          <br />
          {orgs?.length ? (
            <select
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              style={{ minWidth: 140 }}
              aria-label="Organization"
            >
              <option value="">Select…</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.id})
                </option>
              ))}
            </select>
          ) : (
            <input
              style={{ width: 110 }}
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              placeholder="org id"
              aria-label="Organization"
            />
          )}
        </div>
        <button type="button" className="btn ghost sm" disabled={loadingOrgs} onClick={listOrgs}>
          {loadingOrgs ? 'Loading…' : orgs ? '↻ Orgs' : 'List my orgs'}
        </button>
        <div>
          <span style={{ fontSize: 10, color: 'var(--muted)' }}>Start</span>
          <br />
          <input
            type="date"
            value={syncStart}
            aria-label="Start"
            onChange={(e) => {
              const v = e.target.value;
              setSyncStart(v);
              // Auto-fill Stop to the semi-monthly period end for the chosen
              // start (15th or month-end) — still editable.
              if (v) {
                try {
                  setSyncStop(periodFor(v).end);
                } catch {
                  // leave Stop unchanged on a malformed start date
                }
              }
            }}
          />
        </div>
        <div>
          <span style={{ fontSize: 10, color: 'var(--muted)' }}>
            Stop <span style={{ fontWeight: 400 }}>(auto)</span>
          </span>
          <br />
          <input
            type="date"
            value={syncStop}
            onChange={(e) => setSyncStop(e.target.value)}
            aria-label="Stop"
          />
        </div>
        <button type="button" className="btn" disabled={syncing} onClick={syncFromHubstaff}>
          {syncing ? 'Importing…' : 'Import Time'}
        </button>
      </div>
    </div>
  );
};
