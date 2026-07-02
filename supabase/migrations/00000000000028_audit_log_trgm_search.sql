-- Trigram indexes for the Audit Log text search.
--
-- getAuditLogPage filters with `or(action.ilike.%q%, entity.ilike.%q%)` —
-- leading-wildcard ILIKE can't use a btree, so as audit_log grows every search
-- scans the company's whole slice. pg_trgm GIN indexes serve infix ILIKE
-- directly.
--
-- Write cost: two GIN indexes on an append-heavy table — acceptable; audit
-- inserts are single-row per admin action, not bulk.
--
-- ADDITIVE + IDEMPOTENT. Do NOT `db push` to shared prod — apply via the SQL
-- Editor / MCP, then record "00000000000028" in supabase/prod-applied.json.

create extension if not exists pg_trgm with schema extensions;

create index if not exists audit_log_action_trgm_idx
  on public.audit_log using gin (action extensions.gin_trgm_ops);
create index if not exists audit_log_entity_trgm_idx
  on public.audit_log using gin (entity extensions.gin_trgm_ops);

-- ROLLBACK: drop index audit_log_action_trgm_idx, audit_log_entity_trgm_idx;
-- (leave the extension — other objects may adopt it.)
