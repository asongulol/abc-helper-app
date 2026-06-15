'use client';

import { Badge } from '@/components/ui';
import { ConfirmDangerModal } from '@/components/ui';
import { useToast } from '@/components/ui';
import type { AnnouncementRow } from '@/db/queries/config';
import { fmtDate } from '@/lib/format';
import {
  deleteAnnouncement,
  postAnnouncement,
  setAnnouncementActive,
} from '@/server/actions/config';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';

interface AnnouncementsCardProps {
  announcements: AnnouncementRow[];
}

/**
 * Announcements card — manage portal welcome-page announcements (From New York).
 * Each announcement is shown to every contractor on their portal welcome page.
 * Supports post / hide-show / delete via config actions.
 */
export const AnnouncementsCard = ({ announcements }: AnnouncementsCardProps) => {
  const toast = useToast();
  const router = useRouter();
  const titleId = useId();
  const messageId = useId();

  const [, startTransition] = useTransition();
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [postBusy, setPostBusy] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<AnnouncementRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const handlePost = () => {
    if (!title.trim()) {
      toast.notify('Title is required.', { type: 'error' });
      return;
    }
    setPostBusy(true);
    startTransition(async () => {
      try {
        const res = await postAnnouncement({ title: title.trim(), body: message.trim() });
        if (res.ok) {
          toast.notify('Announcement posted.', { type: 'success' });
          setTitle('');
          setMessage('');
          router.refresh();
        } else {
          toast.notify(res.error, { type: 'error' });
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Failed to post announcement.', {
          type: 'error',
        });
      } finally {
        setPostBusy(false);
      }
    });
  };

  const handleToggleActive = (announcement: AnnouncementRow) => {
    startTransition(async () => {
      try {
        const res = await setAnnouncementActive({
          id: announcement.id,
          active: !announcement.active,
        });
        if (res.ok) {
          toast.notify(announcement.active ? 'Announcement hidden.' : 'Announcement shown.', {
            type: 'success',
          });
          router.refresh();
        } else {
          toast.notify(res.error, { type: 'error' });
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Failed to update announcement.', {
          type: 'error',
        });
      }
    });
  };

  const handleDeleteConfirm = () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    startTransition(async () => {
      try {
        const res = await deleteAnnouncement({ id: deleteTarget.id });
        if (res.ok) {
          toast.notify('Announcement deleted.', { type: 'success' });
          setDeleteTarget(null);
          router.refresh();
        } else {
          toast.notify(res.error, { type: 'error' });
          setDeleteBusy(false);
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Failed to delete announcement.', {
          type: 'error',
        });
        setDeleteBusy(false);
      }
    });
  };

  return (
    <div className="card">
      <h3>Announcements</h3>
      <p className="sub">
        Shown to every contractor on their portal welcome page ("From New York").
      </p>

      <div className="row">
        <div className="field" style={{ minWidth: 220 }}>
          <label htmlFor={titleId}>Title</label>
          <input
            id={titleId}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            disabled={postBusy}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor={messageId}>Message</label>
        <textarea
          id={messageId}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Message (optional)"
          rows={3}
          disabled={postBusy}
        />
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn"
          onClick={handlePost}
          disabled={postBusy || !title.trim()}
        >
          {postBusy ? 'Posting…' : 'Post announcement'}
        </button>
      </div>

      {announcements.length === 0 ? (
        <p className="muted">No announcements yet.</p>
      ) : (
        announcements.map((a) => (
          <div key={a.id} className="card" style={{ marginTop: 12 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong>{a.title}</strong>{' '}
                <Badge tone={a.active ? 'good' : 'neutral'}>{a.active ? 'active' : 'hidden'}</Badge>
                <div className="sub">{fmtDate(a.publishedAt)}</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => handleToggleActive(a)}
                >
                  {a.active ? 'Hide' : 'Show'}
                </button>
                <button
                  type="button"
                  className="btn danger-outline sm"
                  onClick={() => setDeleteTarget(a)}
                >
                  Delete
                </button>
              </div>
            </div>
            {a.body ? <p style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{a.body}</p> : null}
          </div>
        ))
      )}

      {deleteTarget != null && (
        <ConfirmDangerModal
          title="Delete announcement"
          message={`Delete "${deleteTarget.title}"?`}
          consequence="This will permanently remove the announcement. This cannot be undone."
          confirmWord="DELETE"
          confirmLabel="Delete"
          busy={deleteBusy}
          onConfirm={handleDeleteConfirm}
          onCancel={() => {
            setDeleteTarget(null);
            setDeleteBusy(false);
          }}
        />
      )}
    </div>
  );
};
