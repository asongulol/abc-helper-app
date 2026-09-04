/**
 * Email templates for new-hire transactional mail.
 *
 * PURE — no server-only import, no I/O. Safe to import in unit tests.
 * Ported faithfully from the legacy portal-admin edge function (lines 56–135).
 *
 * Merge keys:
 *   welcome      → {{name}} {{wise_referral_url}} {{portal_url}} {{email}} {{password}}
 *   credentials  → {{name}} {{portal_url}} {{email}} {{password}}
 *   tools        → {{name}} {{portal_url}} {{tools_block}}
 *   withdraw     → {{name}}
 *   contract_review        → {{name}} {{portal_url}} {{version}} {{effective_from}}
 *   contract_countersigned → {{name}} {{print_url}} {{version}} {{effective_from}}
 *   doc_request    → {{name}} {{doc_title}} {{portal_url}}
 *   owed_reminder  → {{name}} {{owed_list}} {{portal_url}}
 */

// ---------------------------------------------------------------------------
// Escape helpers
// ---------------------------------------------------------------------------

/** HTML-escape a value before interpolating into a template body. */
export const escapeHtml = (x: unknown): string =>
  String(x ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** Replace {{key}} tokens with values from `vars`. Unknown keys are left as-is. */
export const mergeTemplate = (tpl: string, vars: Record<string, string>): string =>
  String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) =>
    k in vars ? (vars[k] ?? m) : m,
  );

// ---------------------------------------------------------------------------
// toolsBlock renderer
// ---------------------------------------------------------------------------

const TOOL_LABEL: Record<string, string> = {
  gmail: 'Company Gmail',
  providersoft: 'Providersoft',
  hubstaff: 'Hubstaff',
  zoom: 'Zoom',
  others: 'Other',
};

/**
 * Render decrypted tool credentials into an HTML block.
 * Generic over whatever fields the admin entered; every value is HTML-escaped.
 */
export const toolsBlock = (creds: unknown): string => {
  if (!creds || typeof creds !== 'object' || Array.isArray(creds)) return '';
  return Object.entries(creds as Record<string, unknown>)
    .map(([tool, fields]) => {
      const label = TOOL_LABEL[tool] ?? tool;
      const inner =
        fields && typeof fields === 'object' && !Array.isArray(fields)
          ? Object.entries(fields as Record<string, unknown>)
              .filter(([, v]) => String(v ?? '').trim())
              .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(String(v))}`)
              .join('<br>')
          : escapeHtml(String(fields ?? ''));
      return inner ? `<p><b>${escapeHtml(label)}</b><br>${inner}</p>` : '';
    })
    .filter(Boolean)
    .join('');
};

// ---------------------------------------------------------------------------
// Default templates (verbatim copy from legacy edge fn)
// ---------------------------------------------------------------------------

export interface EmailTemplate {
  subject: string;
  html: string;
}

export interface HireEmailConfig {
  auto_send: boolean;
  portal_url: string;
  hubstaff_install_url: string;
  wise_referral_url: string;
  welcome: EmailTemplate;
  credentials: EmailTemplate;
  tools: EmailTemplate;
  withdraw: EmailTemplate;
  /** A new contract version is out for signature (docs/CONTRACT-VERSIONS-PLAN.md §3, send). */
  contract_review: EmailTemplate;
  /** A version was countersigned and is now the contract of record (§4 step 6). */
  contract_countersigned: EmailTemplate;
  /** An admin requested one more document (§7 decision 5). */
  doc_request: EmailTemplate;
  /** Everything a current contractor still owes, in one email (§7 decision 5). */
  owed_reminder: EmailTemplate;
}

export const DEFAULT_HIRE_EMAILS: HireEmailConfig = {
  auto_send: true,
  portal_url: 'https://3a.abbilabs.com/portal',
  hubstaff_install_url: 'https://hubstaff.com/download',
  wise_referral_url: 'https://wise.com/invite/dic/olivert410',
  // Email 1 (sent at hire): thank-you + onboarding intro + Wise button + prepare
  // docs + login credentials, all in one. Merge: {{name}} {{wise_referral_url}}
  // {{portal_url}} {{email}} {{password}}.
  welcome: {
    subject: 'Welcome to Aaron Anderson E.H.S. LLC — let’s get you onboarded',
    html: [
      '<p>Hi {{name}},</p>',
      "<p>Thank you for joining Aaron Anderson E.H.S. LLC — we're excited to have you on the team! Here's how to get started.</p>",
      '<p><b>Your onboarding, in the portal:</b></p>',
      '<ol><li>Sign your agreements (IC Agreement, Non-Compete, NDA, BAA)</li><li>Complete your profile and billing / payout details</li><li>Upload your documents</li></ol>',
      '<p><b>First, set up Wise.</b> We pay in Philippine Pesos via Wise, so please create your Wise account now — you’ll add your payout details during onboarding:</p>',
      '<p><a href="{{wise_referral_url}}" style="display:inline-block;padding:11px 20px;background:#1F3A68;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">Create your Wise account</a></p>',
      '<p><b>Please prepare these documents</b> to upload in the portal: Resume / CV, Diploma / TOR, NBI Clearance, and a Gov ID / Passport (front &amp; back).</p>',
      '<p><b>Your portal login</b><br>Portal: <a href="{{portal_url}}">{{portal_url}}</a><br>Username: {{email}}<br>Temporary password: {{password}}</p>',
      '<p>You’ll set your own password on first sign-in. Questions? Just reply to this email.</p>',
      '<p>Welcome aboard!<br>— Aaron Anderson E.H.S. LLC</p>',
    ].join('\n'),
  },
  // Login-only email — reused when an admin RE-ISSUES a temp password (reset).
  credentials: {
    subject: 'Your Aaron Anderson E.H.S. LLC contractor portal login',
    html: [
      '<p>Hi {{name}},</p>',
      '<p>Here are your contractor portal sign-in details.</p>',
      '<p><b>Portal:</b> <a href="{{portal_url}}">{{portal_url}}</a><br>',
      '<b>Username:</b> {{email}}<br>',
      '<b>Temporary password:</b> {{password}}</p>',
      '<p>You’ll set your own password on first sign-in.</p>',
      '<p>— Aaron Anderson E.H.S. LLC</p>',
    ].join('\n'),
  },
  // Email 2 (sent at onboarding completion): the provisioned tool logins.
  // {{tools_block}} is rendered server-side from the decrypted credentials.
  tools: {
    subject: 'Your Aaron Anderson E.H.S. LLC tool access',
    html: [
      '<p>Hi {{name}},</p>',
      '<p>Your onboarding is complete — here are the tool logins you’ll need to get started:</p>',
      '{{tools_block}}',
      '<p>Please keep these secure and, where possible, change any passwords on first sign-in. You can also view them anytime in the portal.</p>',
      '<p>— Aaron Anderson E.H.S. LLC</p>',
    ].join('\n'),
  },
  // Sent when an admin WITHDRAWS an offer / cancels an onboarding before it
  // completes. Polite, brief, no portal links (the login is revoked).
  withdraw: {
    subject: 'Update on your Aaron Anderson E.H.S. LLC offer',
    html: [
      '<p>Hi {{name}},</p>',
      '<p>Thank you for your interest in working with Aaron Anderson E.H.S. LLC and for the time you’ve invested so far.</p>',
      '<p>After further review we won’t be moving forward with onboarding at this time, and your contractor portal access has been deactivated.</p>',
      '<p>We’re grateful for the opportunity to have connected, and we wish you all the best. If anything changes on our side, we’ll be in touch.</p>',
      '<p>Warm regards,<br>— Aaron Anderson E.H.S. LLC</p>',
    ].join('\n'),
  },
  // Sent by sendContractVersion: a new version of the IC agreement is waiting
  // in the portal. The prior agreement stays in force until countersign.
  contract_review: {
    subject: 'Your updated Aaron Anderson E.H.S. LLC contractor agreement is ready to sign',
    html: [
      '<p>Hi {{name}},</p>',
      '<p>A new version of your Independent Contractor Agreement (version {{version}}) is ready for your review and signature. The new terms take effect on <b>{{effective_from}}</b>.</p>',
      '<p>Please sign in to the contractor portal, read the agreement through to the end, and sign it:</p>',
      '<p><a href="{{portal_url}}" style="display:inline-block;padding:11px 20px;background:#1F3A68;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">Review and sign</a></p>',
      '<p>Your current agreement stays in force until the new one is countersigned. Questions? Just reply to this email.</p>',
      '<p>— Aaron Anderson E.H.S. LLC</p>',
    ].join('\n'),
  },
  // Sent at countersign: the version is now the contract of record.
  contract_countersigned: {
    subject: 'Your Aaron Anderson E.H.S. LLC contractor agreement is countersigned',
    html: [
      '<p>Hi {{name}},</p>',
      '<p>Version {{version}} of your Independent Contractor Agreement has been countersigned and is now your agreement of record, effective <b>{{effective_from}}</b>.</p>',
      '<p>You can view or print your signed copy anytime: <a href="{{print_url}}">{{print_url}}</a></p>',
      '<p>— Aaron Anderson E.H.S. LLC</p>',
    ].join('\n'),
  },
  // Sent by requestDocument: one more document joins the portal's owed list.
  doc_request: {
    subject: 'Document requested: {{doc_title}}',
    html: [
      '<p>Hi {{name}},</p>',
      '<p>We need one more document from you: <b>{{doc_title}}</b>.</p>',
      '<p>Please upload it in the contractor portal under Documents:</p>',
      '<p><a href="{{portal_url}}/docs" style="display:inline-block;padding:11px 20px;background:#1F3A68;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">Upload document</a></p>',
      '<p>Questions? Just reply to this email.</p>',
      '<p>— Aaron Anderson E.H.S. LLC</p>',
    ].join('\n'),
  },
  // Sent by remindContractor: {{owed_list}} is a rendered <ul> of everything
  // still owed (contract to sign, documents to upload / renew).
  owed_reminder: {
    subject: 'Reminder: items still needed for your contractor file',
    html: [
      '<p>Hi {{name}},</p>',
      '<p>A quick reminder — we are still waiting on the following:</p>',
      '{{owed_list}}',
      '<p>Everything can be done in the contractor portal:</p>',
      '<p><a href="{{portal_url}}" style="display:inline-block;padding:11px 20px;background:#1F3A68;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">Open the portal</a></p>',
      '<p>Questions? Just reply to this email.</p>',
      '<p>— Aaron Anderson E.H.S. LLC</p>',
    ].join('\n'),
  },
};
