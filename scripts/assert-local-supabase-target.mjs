#!/usr/bin/env node
/**
 * Guard: refuse remote-targeting Supabase commands (db push, migration repair)
 * when the checkout is linked to the SHARED PROD project.
 *
 * abc-helper-app shares prod (cgsidolrauzsowqlllsz) with 3 live original apps and
 * must NEVER push its repo migration lineage there. Prod-side changes go ONLY via
 * audit/*.sql in the Dashboard SQL Editor. Run this before `supabase db push`.
 *
 * Pure Node, no deps. Exits 1 (loudly) if the linked ref is prod.
 * NOTE: this only guards commands invoked through the npm scripts that call it
 * (db:push). The in-DB guard migration 00000000000000_assert_not_shared_prod.sql
 * is the backstop for a raw `supabase db push`.
 */

import { existsSync, readFileSync } from 'node:fs';

const PROD_REF = 'cgsidolrauzsowqlllsz'; // shared prod — never a repo-migration target
const REF_FILE = 'supabase/.temp/project-ref';

if (!existsSync(REF_FILE)) {
  // Not linked to anything — nothing to push to; let the underlying command speak.
  console.log('✓ db target check: no linked project.');
  process.exit(0);
}

const ref = readFileSync(REF_FILE, 'utf8').trim();
if (ref === PROD_REF) {
  console.error(
    `\n⛔ Refusing remote DB command: this checkout is linked to the SHARED PROD project (${PROD_REF}).\n` +
      '   abc-helper-app must NEVER push its repo migrations to prod (it shares that DB with the live apps).\n' +
      '   Apply prod-side changes via audit/*.sql in the Dashboard SQL Editor instead.\n' +
      '   See docs/PROD-CONFORMANCE-PLAN.md.\n',
  );
  process.exit(1);
}
console.log(`✓ db target check: linked to ${ref} (not prod).`);
