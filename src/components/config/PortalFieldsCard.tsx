'use client';

import { useToast } from '@/components/ui';
import { useUnsavedGuard } from '@/components/ui';
import { EDITABLE_FIELDS } from '@/lib/config/fields';
import { setEditableFields } from '@/server/actions/config';
import { useId, useState, useTransition } from 'react';

interface PortalFieldsCardProps {
  /** Currently-selected editable field keys. */
  selected: string[];
  onClose: () => void;
}

/**
 * Modal body (manifest 25): tick the profile fields contractors may edit
 * themselves in the portal. Renders one checkbox per EDITABLE_FIELDS entry and
 * saves via setEditableFields. Payout destination is intentionally admin-only.
 * Verbatim parity with the legacy PortalSettingsModal: only a single "Save"
 * button (Close lives in the Modal header) — no Select all / Clear / Cancel.
 */
export const PortalFieldsCard = ({ selected, onClose }: PortalFieldsCardProps) => {
  const toast = useToast();
  const baseId = useId();

  const [checked, setChecked] = useState<Set<string>>(() => new Set(selected));
  const [isPending, startTransition] = useTransition();

  const initial = new Set(selected);
  const changed = checked.size !== initial.size || ![...checked].every((k) => initial.has(k));

  useUnsavedGuard({ dirty: changed });

  const toggle = (key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleSave = () => {
    startTransition(async () => {
      try {
        const res = await setEditableFields({ fields: [...checked] });
        if (res.ok) {
          toast.notify('Editable fields saved.', { type: 'success' });
          onClose();
        } else {
          toast.notify(res.error, { type: 'error' });
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Failed to save fields.', {
          type: 'error',
        });
      }
    });
  };

  return (
    <div>
      <p className="sub">
        Tick the profile fields contractors may edit themselves in the portal. Payout destination
        (Wise recipient ID/UUID) is always admin-only.
      </p>

      <div style={{ marginTop: 12 }}>
        {EDITABLE_FIELDS.map((field) => {
          const id = `${baseId}-${field.key}`;
          return (
            <label
              key={field.key}
              htmlFor={id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 0',
                fontSize: 14,
              }}
            >
              <input
                id={id}
                type="checkbox"
                checked={checked.has(field.key)}
                onChange={() => toggle(field.key)}
                disabled={isPending}
              />
              {field.label}
            </label>
          );
        })}
      </div>

      <div className="actions" style={{ marginTop: 10 }}>
        <button type="button" className="btn" onClick={handleSave} disabled={isPending}>
          {isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
};
