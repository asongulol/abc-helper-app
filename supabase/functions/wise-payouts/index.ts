// Supabase Edge Function: wise-payouts (Deno thin wrapper)
// ---------------------------------------------------------------------------
// ARCHITECTURE NOTE — SINGLE SOURCE OF TRUTH
// ---------------------------------------------------------------------------
// This is the CRON reconcile path for Wise payouts. The on-demand, admin-
// triggered reconcile lives in the Next.js app (src/server/actions/wise.ts →
// src/server/wise/service.ts servicePoll); this function is its scheduled twin
// for environments where a cron tick — not a logged-in admin — drives the work.
//
// It is a thin Deno wrapper that:
//   1. Authenticates the incoming request (x-cron-secret checked against
//      app_secrets.cron_secret — identical to hubstaff-sync; cron has no end
//      user, so a Supabase user JWT cannot apply).
//   2. Reads payments that already have a wise_transfer_id (drafted in Wise) via
//      the Supabase REST API (fetch-only, no Node SDK).
//   3. Pulls each transfer's detail from the Wise API (GET /v1/transfers/{id}).
//   4. Flips payments.status to 'sent' for terminal-success Wise states, using
//      Wise's REAL sent date plus the wise_dates triple and an auto-lock.
//   5. Calls the pure date helpers (vendored / copy below — Deno cannot import
//      from the Next.js src/ tree at runtime). Keep the vendored copy in sync
//      with src/lib/wise/dates.ts and src/lib/wise/types.ts.
//
// MONEY IS DRAFT-ONLY (ADR-0007). This function NEVER funds: it only GETs
// transfer detail and PATCHes payment status. There is, by construction, no
// POST .../payments (funding) call here. The build-time guardrail
// (scripts/guardrails.mjs) scans this directory too.
//
// Deploy:
//   supabase functions deploy wise-payouts
//   supabase secrets set WISE_API_TOKEN="..."
//   supabase secrets set WISE_PROFILE_ID="..."   # optional; not needed for poll
//   supabase secrets set CRON_SECRET="..."        # shared with app env
//   # then schedule it (pg_cron / Supabase scheduled function) post-cutover,
//   # per docs/CUTOVER-VERIFICATION.md.
// ---------------------------------------------------------------------------

const WISE_BASE = Deno.env.get("WISE_API_BASE") ?? "https://api.wise.com";
const WISE_TOKEN = Deno.env.get("WISE_API_TOKEN") ?? "";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const tokHdr = {
	apikey: SB_KEY,
	Authorization: `Bearer ${SB_KEY}`,
	"Content-Type": "application/json",
};

const cors = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers":
		"authorization, x-client-info, apikey, content-type",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...cors, "Content-Type": "application/json" },
	});
}

// ── Pure helpers (vendored from src/lib/wise/types.ts + src/lib/wise/dates.ts) ──
// Keep in sync manually — these have zero runtime deps (no fetch, no env).

/** Terminal success states returned by Wise (mirrors WISE_PAID_STATES). */
const WISE_PAID_STATES = new Set([
	"outgoing_payment_sent",
	"completed",
	"sent",
]);

/** In-flight states (not terminal, not cancelled) (mirrors WISE_IN_FLIGHT_STATES). */
const WISE_IN_FLIGHT_STATES = new Set([
	"processing",
	"funds_converted",
	"incoming_payment_waiting",
	"waiting_recipient_input_to_proceed",
]);

interface WiseDates {
	created: string | null;
	dateFunded: string | null;
	dateSent: string | null;
}

/** Normalise a Wise timestamp to an ISO string, or null if unparseable. */
function toIsoWise(v: unknown): string | null {
	if (v == null) return null;
	const s = String(v).trim();
	if (!s) return null;
	const iso = s.includes("T") ? s : `${s.replace(" ", "T")}Z`;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Derive the created/dateFunded/dateSent triple from a FULL transfer detail object. */
function wiseDatesFromRow(row: Record<string, unknown>): WiseDates {
	return {
		created: toIsoWise(row.created ?? row.createdAt),
		dateFunded: toIsoWise(row.dateFunded ?? row.fundedDate ?? null),
		dateSent: toIsoWise(row.dateSent ?? row.sentDate ?? null),
	};
}

/** Pick the best sent timestamp (precedence: dateSent > dateFunded > created). */
function bestSentDate(dates: WiseDates): string | null {
	return dates.dateSent ?? dates.dateFunded ?? dates.created ?? null;
}

// ── Bounded concurrency (mirrors mapLimit in service.ts) ───────────────────────

async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		async () => {
			for (;;) {
				const i = next++;
				if (i >= items.length) break;
				out[i] = await fn(items[i] as T);
			}
		},
	);
	await Promise.all(workers);
	return out;
}

// ── Wise API (GET only — read-only against Wise) ───────────────────────────────

async function wiseGet<T>(path: string): Promise<T> {
	if (!WISE_TOKEN) throw new Error("no Wise token (set WISE_API_TOKEN)");
	const r = await fetch(`${WISE_BASE}${path}`, {
		headers: {
			Authorization: `Bearer ${WISE_TOKEN}`,
			"Content-Type": "application/json",
		},
	});
	if (!r.ok)
		throw new Error(`Wise GET ${path} → ${r.status}: ${await r.text()}`);
	return r.json() as Promise<T>;
}

// ── Cron reconcile handler (poll) ──────────────────────────────────────────────

interface PollPayment {
	id: string;
	wise_transfer_id: string;
	status: string;
}

async function handleCronReconcile(
	body: Record<string, unknown>,
): Promise<Response> {
	// Fail fast on a misconfigured cron: without a token every transfer lookup
	// would throw and fall through to 'unknown', reporting a bogus 200/markedPaid:0
	// success while reconciling nothing.
	if (!WISE_TOKEN)
		return json({ error: "WISE_API_TOKEN not set — cannot reconcile" }, 500);

	// Default to the fast, idempotent path: only re-check status='draft' rows.
	const onlyDrafts = body.only_drafts !== false;
	const payPeriodId = body.pay_period_id
		? String(body.pay_period_id).trim()
		: "";

	// Fetch payments already drafted in Wise (mirrors fetchPollPayments).
	let q = `${SB_URL}/rest/v1/payments?wise_transfer_id=not.is.null&select=id,wise_transfer_id,status`;
	if (onlyDrafts) q += "&status=eq.draft";
	if (payPeriodId) q += `&pay_period_id=eq.${encodeURIComponent(payPeriodId)}`;

	const pRes = await fetch(q, { headers: tokHdr });
	if (!pRes.ok)
		return json({ error: `payments fetch failed (${pRes.status})` }, 500);
	const payments = ((await pRes.json()) as PollPayment[]).filter(
		(p) => p.wise_transfer_id,
	);

	if (payments.length === 0) {
		return json({
			ok: true,
			checked: 0,
			markedPaid: 0,
			inFlight: 0,
			unknown: 0,
		});
	}

	const nowIso = new Date().toISOString();

	const outcomes = await mapLimit(payments, 8, async (p) => {
		let detail: Record<string, unknown>;
		try {
			detail = await wiseGet<Record<string, unknown>>(
				`/v1/transfers/${p.wise_transfer_id}`,
			);
		} catch {
			return { kind: "unknown" as const, p };
		}
		const st = String(detail.status ?? "");

		if (WISE_PAID_STATES.has(st)) {
			const dates = wiseDatesFromRow(detail);
			const realSent = bestSentDate(dates) ?? nowIso;
			// IMPORTANT: this PATCH only writes status/dates. No funding endpoint is called.
			const up = await fetch(`${SB_URL}/rest/v1/payments?id=eq.${p.id}`, {
				method: "PATCH",
				headers: { ...tokHdr, Prefer: "return=minimal" },
				body: JSON.stringify({
					status: "sent",
					paid_at: realSent,
					wise_dates: dates,
					wise_locked_at: nowIso,
				}),
			});
			return {
				kind: up.ok ? ("paid" as const) : ("unknown" as const),
				p,
				status: st,
			};
		}
		if (WISE_IN_FLIGHT_STATES.has(st))
			return { kind: "inFlight" as const, p, status: st };
		// cancelled / refunded / bounced_back / etc. — surface but don't change the row.
		return { kind: "other" as const, p, status: st };
	});

	const markedPaid = outcomes.filter((o) => o.kind === "paid").length;
	const inFlight = outcomes.filter((o) => o.kind === "inFlight").length;
	const unknown = outcomes.filter((o) => o.kind === "unknown").length;

	return json({
		ok: true,
		checked: payments.length,
		markedPaid,
		inFlight,
		unknown,
	});
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
	if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
	try {
		const body = (await req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;

		// Auth — shared x-cron-secret, identical to hubstaff-sync.
		const action = String(body.action ?? "cron_reconcile");
		const provided =
			req.headers.get("x-cron-secret") ?? String(body.secret ?? "");
		const sRes = await fetch(
			`${SB_URL}/rest/v1/app_secrets?key=eq.cron_secret&select=value`,
			{
				headers: tokHdr,
			},
		);
		const expected = sRes.ok ? (await sRes.json())?.[0]?.value : null;
		if (!expected || provided !== expected)
			return json({ error: "unauthorized" }, 401);

		if (action === "cron_reconcile") return handleCronReconcile(body);

		return json({ error: `unknown action: ${action}` }, 400);
	} catch (e) {
		return json({ error: String((e as Error).message ?? e) }, 500);
	}
});
