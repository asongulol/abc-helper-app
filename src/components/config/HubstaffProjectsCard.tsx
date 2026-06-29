'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import type { SortableColumn } from '@/components/ui';
import { EmptyState, SortableTable, Spinner, useToast } from '@/components/ui';
import type { CompanyFullRow, HubstaffProjectRow } from '@/db/queries/config';
import { assignHubstaffProject, loadHubstaffProjects } from '@/server/actions/config';

interface HubstaffProjectsCardProps {
  projects: HubstaffProjectRow[];
  clients: CompanyFullRow[];
  employer: CompanyFullRow | null;
  onClose: () => void;
}

/**
 * Modal body for mapping Hubstaff projects to client companies. Each project's
 * tracked time is attributed to the assigned client; unassigned projects fall
 * back to the company the daily sync runs for. Manifest 24.
 */
export const HubstaffProjectsCard = ({
  projects,
  clients,
  employer,
  onClose,
}: HubstaffProjectsCardProps) => {
  const { notify } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const companyOptions: CompanyFullRow[] = employer ? [employer, ...clients] : clients;

  const handleLoad = () => {
    startTransition(async () => {
      try {
        const res = await loadHubstaffProjects();
        if (res.ok) {
          notify(`Loaded ${res.data?.count ?? 0} project(s).`, {
            type: 'success',
          });
          router.refresh();
        } else {
          notify(res.error, { type: 'error' });
        }
      } catch (e) {
        notify(e instanceof Error ? e.message : 'Failed to load projects.', {
          type: 'error',
        });
      }
    });
  };

  const handleAssign = (project: HubstaffProjectRow, companyId: string) => {
    startTransition(async () => {
      try {
        const res = await assignHubstaffProject({
          hubstaffProjectId: project.hubstaffProjectId,
          companyId,
        });
        if (res.ok) {
          notify('Assignment saved.', { type: 'success' });
        } else {
          notify(res.error, { type: 'error' });
        }
      } catch (e) {
        notify(e instanceof Error ? e.message : 'Failed to assign project.', {
          type: 'error',
        });
      }
    });
  };

  const columns: ReadonlyArray<SortableColumn<HubstaffProjectRow>> = [
    {
      key: 'name',
      label: 'Project',
      sortable: true,
      cardTitle: true,
      accessor: (r) => r.name ?? '',
      render: (r) => r.name ?? <span className="muted">—</span>,
    },
    {
      key: 'companyId',
      label: 'Assigned client',
      sortable: false,
      render: (r) => (
        <select
          value={r.companyId}
          onChange={(e) => handleAssign(r, e.target.value)}
          disabled={isPending}
          aria-label={`Assigned client for ${r.name ?? 'project'}`}
        >
          {companyOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      ),
    },
  ];

  return (
    <div>
      <p className="sub">
        Assign each Hubstaff project to the client company it bills to. Tracked time on that project
        is then attributed to that client. Unassigned projects fall back to the company the daily
        sync runs for.
      </p>

      {employer?.hubstaffOrgId != null && (
        <p className="muted">Hubstaff org {employer.hubstaffOrgId}</p>
      )}

      <div className="actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          Close
        </button>
        <button type="button" className="btn" onClick={handleLoad} disabled={isPending}>
          {isPending ? 'Loading…' : 'Load projects'}
        </button>
      </div>

      {isPending && <Spinner />}

      {projects.length === 0 ? (
        <EmptyState icon="🔌" message="No projects loaded yet — press Load projects." />
      ) : (
        <SortableTable
          columns={columns}
          rows={projects}
          rowKey={(r) => String(r.hubstaffProjectId)}
          filterable={projects.length > 5}
          filterPlaceholder="Filter projects…"
        />
      )}
    </div>
  );
};
