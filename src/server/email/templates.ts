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
    subject: 'Welcome to ABC Kids — let’s get you onboarded',
    html: [
      '<p>Hi {{name}},</p>',
      "<p>Thank you for joining ABC Kids NY — we're excited to have you on the team! Here's how to get started.</p>",
      '<p><b>Your onboarding, in the portal:</b></p>',
      '<ol><li>Sign your agreements (IC Agreement, Non-Compete, NDA, BAA)</li><li>Complete your profile and billing / payout details</li><li>Upload your documents</li></ol>',
      '<p><b>First, set up Wise.</b> We pay in Philippine Pesos via Wise, so please create your Wise account now — you’ll add your payout details during onboarding:</p>',
      '<p><a href="{{wise_referral_url}}" style="display:inline-block;padding:11px 20px;background:#1F3A68;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">Create your Wise account</a></p>',
      '<p><b>Please prepare these documents</b> to upload in the portal: Resume / CV, Diploma / TOR, NBI Clearance, and a Gov ID / Passport (front &amp; back).</p>',
      '<p><b>Your portal login</b><br>Portal: <a href="{{portal_url}}">{{portal_url}}</a><br>Username: {{email}}<br>Temporary password: {{password}}</p>',
      '<p>You’ll set your own password on first sign-in. Questions? Just reply to this email.</p>',
      '<p>Welcome aboard!<br>— ABC Kids NY</p>',
    ].join('\n'),
  },
  // Login-only email — reused when an admin RE-ISSUES a temp password (reset).
  credentials: {
    subject: 'Your ABC Kids contractor portal login',
    html: [
      '<p>Hi {{name}},</p>',
      '<p>Here are your contractor portal sign-in details.</p>',
      '<p><b>Portal:</b> <a href="{{portal_url}}">{{portal_url}}</a><br>',
      '<b>Username:</b> {{email}}<br>',
      '<b>Temporary password:</b> {{password}}</p>',
      '<p>You’ll set your own password on first sign-in.</p>',
      '<p>— ABC Kids NY</p>',
    ].join('\n'),
  },
  // Email 2 (sent at onboarding completion): the provisioned tool logins.
  // {{tools_block}} is rendered server-side from the decrypted credentials.
  tools: {
    subject: 'Your ABC Kids tool access',
    html: [
      '<p>Hi {{name}},</p>',
      '<p>Your onboarding is complete — here are the tool logins you’ll need to get started:</p>',
      '{{tools_block}}',
      '<p>Please keep these secure and, where possible, change any passwords on first sign-in. You can also view them anytime in the portal.</p>',
      '<p>— ABC Kids NY</p>',
    ].join('\n'),
  },
  // Sent when an admin WITHDRAWS an offer / cancels an onboarding before it
  // completes. Polite, brief, no portal links (the login is revoked).
  withdraw: {
    subject: 'Update on your ABC Kids offer',
    html: [
      '<p>Hi {{name}},</p>',
      '<p>Thank you for your interest in working with ABC Kids NY and for the time you’ve invested so far.</p>',
      '<p>After further review we won’t be moving forward with onboarding at this time, and your contractor portal access has been deactivated.</p>',
      '<p>We’re grateful for the opportunity to have connected, and we wish you all the best. If anything changes on our side, we’ll be in touch.</p>',
      '<p>Warm regards,<br>— ABC Kids NY</p>',
    ].join('\n'),
  },
};
