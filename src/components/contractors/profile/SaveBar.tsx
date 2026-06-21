import { Spinner } from '@/components/ui';

/** Save action bar shared by the editable tabs (legacy: single "Save details"). */
export function SaveBar({ isPending, serverError }: { isPending: boolean; serverError: string }) {
  return (
    <>
      {serverError && (
        <div
          className="banner"
          style={{
            marginTop: 14,
            borderColor: 'var(--bad)',
            background: 'var(--bad-soft)',
            color: 'var(--bad)',
          }}
        >
          {serverError}
        </div>
      )}
      <div className="actions" style={{ marginTop: 20 }}>
        <button type="submit" className="btn" disabled={isPending}>
          {isPending ? (
            <>
              <Spinner /> Saving…
            </>
          ) : (
            'Save details'
          )}
        </button>
      </div>
    </>
  );
}
