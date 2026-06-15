-- ============================================================================
-- At most one fileless (no-upload) waive/defer placeholder per (worker, kind,
-- side). resolveMissingDocumentSlot does delete-then-insert; this partial unique
-- index is the safety net against a concurrent-admin race leaving duplicate
-- placeholder rows. Scoped to the waive/defer placeholders only (storage_path
-- NULL AND review_status in ('waived','deferred')) so real uploads and any other
-- fileless rows are unaffected.
-- ============================================================================
create unique index if not exists documents_fileless_slot_uniq
  on documents (worker_id, kind, coalesce(side, ''))
  where storage_path is null and review_status in ('waived', 'deferred');

-- ROLLBACK: drop index if exists documents_fileless_slot_uniq;
