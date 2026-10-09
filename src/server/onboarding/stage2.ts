import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';
import {
  isStage2Complete,
  STAGE2_COLUMNS,
  type Stage2Missing,
  stage2Missing,
} from '@/lib/onboarding/stage2';

type Svc = SupabaseClient<Database>;

/**
 * Re-derive stage 2 from the saved profile and persist it when it changed.
 * Called after every portal profile save AND on the onboarding page load, so
 * an admin filling a field on the contractor's behalf also unlocks stage 3.
 * Never reopens a finished onboarding; never advances past stage 1.
 */
export async function syncStage2(svc: Svc, workerId: string): Promise<Stage2Missing> {
  const [{ data: w }, { data: op }] = await Promise.all([
    svc.from('workers').select(STAGE2_COLUMNS).eq('id', workerId).maybeSingle(),
    svc
      .from('onboarding_progress')
      .select('stage1_complete, stage2_complete, current_stage, completed_at')
      .eq('worker_id', workerId)
      .maybeSingle(),
  ]);
  const missing = stage2Missing(w as Record<string, unknown> | null);
  if (!op?.stage1_complete || op.completed_at) return missing;

  const complete = isStage2Complete(missing);
  const stage = op.current_stage ?? 'stage2_profile';
  const next = complete && stage === 'stage2_profile' ? 'stage3_docs' : stage;
  if (complete === !!op.stage2_complete && next === stage) return missing;

  await svc
    .from('onboarding_progress')
    .update({
      stage2_complete: complete,
      current_stage: next,
      updated_at: new Date().toISOString(),
    })
    .eq('worker_id', workerId);
  return missing;
}
