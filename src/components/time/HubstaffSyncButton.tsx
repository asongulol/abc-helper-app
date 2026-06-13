'use client';

/**
 * HubstaffSyncButton — minimal 'Sync from Hubstaff' trigger for the Time Import
 * screen. Calls the syncHubstaffNow server action for the selected company and
 * current period, then triggers a page refresh on success.
 *
 * Consistent with CsvImportCard: uses useToast for feedback, useTransition for
 * pending state, and calls onImported() to refresh the parent table.
 */

import { useToast } from '@/components/ui';
import { syncHubstaffNow } from '@/server/actions/hubstaff';
import { useTransition } from 'react';

interface HubstaffSyncButtonProps {
  companyId: string;
  /** 'YYYY-MM-DD' start of the currently selected pay period. */
  periodStart: string;
  /** 'YYYY-MM-DD' end of the currently selected pay period. */
  periodEnd: string;
  /** Called on successful sync to trigger a table refresh. */
  onImported: () => void;
}

export const HubstaffSyncButton = ({
  companyId,
  periodStart,
  periodEnd,
  onImported,
}: HubstaffSyncButtonProps) => {
  const { notify } = useToast();
  const [pending, startTransition] = useTransition();

  const handleSync = () => {
    startTransition(async () => {
      const res = await syncHubstaffNow({
        companyId,
        periodStart,
        periodEnd,
      });

      if (!res.ok) {
        notify(res.error, { type: 'error' });
        return;
      }

      const { rowsWritten, membersSeen, unmatched } = res.data ?? {
        rowsWritten: 0,
        membersSeen: 0,
        unmatched: [],
      };

      const unmatchedNote =
        unmatched.length > 0 ? ` · ${unmatched.length} unmatched: ${unmatched.join(', ')}` : '';

      notify(
        `Hubstaff sync complete — ${rowsWritten} entr${rowsWritten === 1 ? 'y' : 'ies'} for ${membersSeen} member${membersSeen === 1 ? '' : 's'}${unmatchedNote}`,
        { type: rowsWritten > 0 ? 'success' : 'info', persistent: unmatched.length > 0 },
      );

      onImported();
    });
  };

  return (
    <button type="button" className="btn ghost" disabled={pending} onClick={handleSync}>
      {pending ? 'Syncing…' : 'Sync from Hubstaff'}
    </button>
  );
};
