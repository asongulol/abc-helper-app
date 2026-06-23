/**
 * Portal query module — contractor-facing reads (RLS user client, scoped to
 * the authenticated contractor via my_worker_id()). No privileged writes here;
 * those live in server actions with explicit service-client checks.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';

type Db = SupabaseClient<Database>;

export type PortalPaymentRow = {
  paymentId: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string | null;
  grossPhp: number;
  haPhp: number;
  t13Php: number;
  pddPhp: number;
  bonusPhp: number;
  /** Informational performance shortfall (rate − gross); NOT subtracted from net. */
  shortfallPhp: number;
  netPhp: number;
  payoutMethod: string | null;
  status: Database['public']['Enums']['payment_status'];
  paidAt: string | null;
};

export type PortalDocumentRow = {
  id: string;
  kind: Database['public']['Enums']['document_kind'];
  title: string | null;
  reviewStatus: Database['public']['Enums']['review_status'];
  reviewReason: string | null;
  storagePath: string | null;
  expiresOn: string | null;
  side: string | null;
  createdAt: string;
};

export type PortalNotificationRow = {
  id: string;
  kind: Database['public']['Enums']['portal_notification_kind'];
  title: string;
  body: string | null;
  createdAt: string;
  dismissedAt: string | null;
};

/** Own payments, ordered newest-first (RLS scopes to authenticated worker). */
export const fetchOwnPayments = async (db: Db, workerId: string): Promise<PortalPaymentRow[]> => {
  const { data, error } = await db
    .from('payments')
    .select(
      'id, pay_period_id, gross_php, health_allowance_php, thirteenth_month_php, pdd_lunch_php, bonus_php, deduction_php, net_php, payout_method, status, paid_at, pay_periods(period_start, period_end, pay_date)',
    )
    .eq('worker_id', workerId)
    .order('pay_period_id', { ascending: false });
  if (error) throw new Error(`own payments: ${error.message}`);
  return (data ?? []).map((p) => ({
    paymentId: p.id,
    periodId: p.pay_period_id,
    periodStart: p.pay_periods?.period_start ?? '',
    periodEnd: p.pay_periods?.period_end ?? '',
    payDate: p.pay_periods?.pay_date ?? null,
    grossPhp: Number(p.gross_php ?? 0),
    haPhp: Number(p.health_allowance_php ?? 0),
    t13Php: Number(p.thirteenth_month_php ?? 0),
    pddPhp: Number(p.pdd_lunch_php ?? 0),
    bonusPhp: Number(p.bonus_php ?? 0),
    shortfallPhp: Number(p.deduction_php ?? 0),
    netPhp: Number(p.net_php ?? 0),
    payoutMethod: p.payout_method,
    status: p.status,
    paidAt: p.paid_at,
  }));
};

/** Own documents (RLS scoped). */
export const fetchOwnDocuments = async (db: Db, workerId: string): Promise<PortalDocumentRow[]> => {
  const { data, error } = await db
    .from('documents')
    .select(
      'id, kind, title, review_status, review_reason, storage_path, expires_on, side, created_at',
    )
    .eq('worker_id', workerId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`own documents: ${error.message}`);
  return (data ?? []).map((d) => ({
    id: d.id,
    kind: d.kind,
    title: d.title,
    reviewStatus: d.review_status,
    reviewReason: d.review_reason,
    storagePath: d.storage_path,
    expiresOn: d.expires_on,
    side: d.side,
    createdAt: d.created_at,
  }));
};

/** Active (non-dismissed) notifications for the worker. */
export const fetchOwnNotifications = async (
  db: Db,
  workerId: string,
): Promise<PortalNotificationRow[]> => {
  const { data, error } = await db
    .from('portal_notifications')
    .select('id, kind, title, body, created_at, dismissed_at')
    .eq('worker_id', workerId)
    .is('dismissed_at', null)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`notifications: ${error.message}`);
  return (data ?? []).map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    createdAt: n.created_at,
    dismissedAt: n.dismissed_at,
  }));
};

/** Active announcements (global, RLS public). */
export const fetchAnnouncements = async (db: Db) => {
  const { data, error } = await db
    .from('announcements')
    .select('id, title, body, published_at, author')
    .eq('active', true)
    .order('published_at', { ascending: false })
    .limit(5);
  if (error) throw new Error(`announcements: ${error.message}`);
  return data ?? [];
};

/** Latest mood check-in for the worker (to check if already submitted today). */
export const fetchLatestMoodCheckin = async (db: Db, workerId: string) => {
  const { data, error } = await db
    .from('mood_checkins')
    .select('id, mood, note, kind, created_at')
    .eq('worker_id', workerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`mood_checkins: ${error.message}`);
  return data;
};

/** Worker profile row. */
export const fetchOwnProfile = async (db: Db, workerId: string) => {
  const { data, error } = await db
    .from('workers')
    .select(
      'id, first_name, middle_name, last_name, email, mobile, ph_address, permanent_address, address_landmark, postal_code, date_of_birth, gcash, paymaya, paypal, wise_tag, emergency_name, emergency_relationship, emergency_mobile, marital_status, education_level, course, year_graduated, school, profile_extras, payout_method, status, hire_date',
    )
    .eq('id', workerId)
    .maybeSingle();
  if (error) throw new Error(`worker profile: ${error.message}`);
  return data;
};

/** Dismiss a notification. */
export const dismissNotification = async (db: Db, notificationId: string): Promise<void> => {
  const { error } = await db
    .from('portal_notifications')
    .update({ dismissed_at: new Date().toISOString() })
    .eq('id', notificationId);
  if (error) throw new Error(`dismiss notification: ${error.message}`);
};

/** Portal settings row (editable_fields config). */
export const fetchPortalSettings = async (db: Db) => {
  const { data, error } = await db
    .from('portal_settings')
    .select('editable_fields, onboarding_config')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error(`portal_settings: ${error.message}`);
  return data;
};

/** Own onboarding progress + signatures. */
export const fetchOwnOnboarding = async (db: Db, workerId: string) => {
  const [progressResult, sigsResult, agreementsResult] = await Promise.all([
    db.from('onboarding_progress').select('*').eq('worker_id', workerId).maybeSingle(),
    db
      .from('onboarding_signatures')
      .select(
        'agreement_kind, signed_legal_name, signature_method, signed_at, signed_date, status, doc_version',
      )
      .eq('worker_id', workerId)
      .eq('status', 'signed')
      .order('signed_at', { ascending: false }),
    db
      .from('onboarding_agreements')
      .select(
        'agreement_kind, countersigned_at, countersigned_name, f_position, f_rate, f_start_date, f_company_name',
      )
      .eq('worker_id', workerId),
  ]);
  if (progressResult.error) throw new Error(`onboarding_progress: ${progressResult.error.message}`);
  if (sigsResult.error) throw new Error(`signatures: ${sigsResult.error.message}`);
  if (agreementsResult.error) throw new Error(`agreements: ${agreementsResult.error.message}`);
  return {
    progress: progressResult.data,
    signatures: sigsResult.data ?? [],
    agreements: agreementsResult.data ?? [],
  };
};

/** Agreement template by kind. */
export const fetchAgreementTemplate = async (
  db: Db,
  kind: Database['public']['Enums']['agreement_kind'],
) => {
  const { data, error } = await db
    .from('agreement_templates')
    .select('kind, title, body, version')
    .eq('kind', kind)
    .maybeSingle();
  if (error) throw new Error(`agreement_templates: ${error.message}`);
  return data;
};

export type PortalTimeEntryRow = {
  id: string;
  workDate: string;
  trackedSeconds: number;
  ptoSeconds: number;
  activityPct: number | null;
  approval: Database['public']['Enums']['approval_status'];
};

/** Own time entries, newest-first (RLS: own rows AND is_onboarded()). */
export const fetchOwnTimeEntries = async (
  db: Db,
  workerId: string,
): Promise<PortalTimeEntryRow[]> => {
  const { data, error } = await db
    .from('time_entries')
    .select('id, work_date, tracked_seconds, pto_seconds, activity_pct, approval')
    .eq('worker_id', workerId)
    .order('work_date', { ascending: false });
  if (error) throw new Error(`own time entries: ${error.message}`);
  return (data ?? []).map((t) => ({
    id: t.id,
    workDate: t.work_date,
    trackedSeconds: Number(t.tracked_seconds ?? 0),
    ptoSeconds: Number(t.pto_seconds ?? 0),
    activityPct: t.activity_pct == null ? null : Number(t.activity_pct),
    approval: t.approval,
  }));
};

/** Insert the worker's own mood check-in (RLS mood_self_insert: worker_id = my_worker_id()). */
export const insertMoodCheckin = async (
  db: Db,
  workerId: string,
  input: { mood: number; note?: string | null; kind?: string | null },
): Promise<void> => {
  const { error } = await db.from('mood_checkins').insert({
    worker_id: workerId,
    mood: input.mood,
    note: input.note ?? null,
    kind: input.kind ?? null,
  });
  if (error) throw new Error(`mood check-in: ${error.message}`);
};
