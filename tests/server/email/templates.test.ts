import {
  DEFAULT_HIRE_EMAILS,
  escapeHtml,
  mergeTemplate,
  toolsBlock,
} from '@/server/email/templates';
import { describe, expect, it } from 'vitest';

describe('escapeHtml', () => {
  it('escapes all five special HTML characters', () => {
    expect(escapeHtml('&<>"\'abc')).toBe('&amp;&lt;&gt;&quot;&#39;abc');
  });

  it('leaves safe strings untouched', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World');
  });

  it('coerces non-string to string', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('mergeTemplate', () => {
  it('replaces known merge keys', () => {
    const result = mergeTemplate('Hello {{name}}, your email is {{email}}.', {
      name: 'Juan',
      email: 'juan@example.com',
    });
    expect(result).toBe('Hello Juan, your email is juan@example.com.');
  });

  it('leaves unknown keys as-is', () => {
    const result = mergeTemplate('Hello {{name}} {{unknown}}', { name: 'Ana' });
    expect(result).toBe('Hello Ana {{unknown}}');
  });

  it('handles whitespace inside braces', () => {
    const result = mergeTemplate('Hi {{ name }}!', { name: 'Ben' });
    expect(result).toBe('Hi Ben!');
  });

  it('handles empty template', () => {
    expect(mergeTemplate('', {})).toBe('');
  });

  it('handles template with no keys', () => {
    expect(mergeTemplate('No keys here.', { name: 'X' })).toBe('No keys here.');
  });
});

describe('toolsBlock', () => {
  it('renders a single tool with labelled fields', () => {
    const creds = { gmail: { email: 'test@abckidsny.com', password: 'secret123' } };
    const html = toolsBlock(creds);
    expect(html).toContain('<b>Company Gmail</b>');
    expect(html).toContain('email: test@abckidsny.com');
    expect(html).toContain('password: secret123');
  });

  it('uses the tool key as label when it is not in TOOL_LABEL', () => {
    const creds = { custom_app: { url: 'https://app.example.com' } };
    const html = toolsBlock(creds);
    expect(html).toContain('<b>custom_app</b>');
    expect(html).toContain('url: https://app.example.com');
  });

  it('escapes HTML in credential values', () => {
    const creds = { hubstaff: { password: '<script>alert(1)</script>' } };
    const html = toolsBlock(creds);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('omits tools with only empty-string fields', () => {
    const creds = { gmail: { email: '', password: '' } };
    const html = toolsBlock(creds);
    expect(html).toBe('');
  });

  it('returns empty string for non-object input', () => {
    expect(toolsBlock(null)).toBe('');
    expect(toolsBlock('string')).toBe('');
    expect(toolsBlock([])).toBe('');
    expect(toolsBlock(undefined)).toBe('');
  });

  it('renders multiple tools', () => {
    const creds = {
      gmail: { email: 'a@b.com' },
      zoom: { password: 'zoompass' },
    };
    const html = toolsBlock(creds);
    expect(html).toContain('Company Gmail');
    expect(html).toContain('Zoom');
  });
});

describe('DEFAULT_HIRE_EMAILS', () => {
  it('welcome template contains all required merge keys', () => {
    const { html } = DEFAULT_HIRE_EMAILS.welcome;
    expect(html).toContain('{{name}}');
    expect(html).toContain('{{portal_url}}');
    expect(html).toContain('{{email}}');
    expect(html).toContain('{{password}}');
    expect(html).toContain('{{wise_referral_url}}');
  });

  it('credentials template contains required merge keys', () => {
    const { html } = DEFAULT_HIRE_EMAILS.credentials;
    expect(html).toContain('{{name}}');
    expect(html).toContain('{{portal_url}}');
    expect(html).toContain('{{email}}');
    expect(html).toContain('{{password}}');
  });

  it('tools template contains {{tools_block}}', () => {
    expect(DEFAULT_HIRE_EMAILS.tools.html).toContain('{{tools_block}}');
  });

  it('withdraw template contains {{name}}', () => {
    expect(DEFAULT_HIRE_EMAILS.withdraw.html).toContain('{{name}}');
  });

  it('welcome merges without leftover tokens for a full var set', () => {
    const vars: Record<string, string> = {
      name: 'Maria',
      email: 'maria@example.com',
      password: 'Abc-xyz123-4567',
      portal_url: 'https://3a.abbilabs.com/portal',
      wise_referral_url: 'https://wise.com/invite/dic/olivert410',
    };
    const merged = mergeTemplate(DEFAULT_HIRE_EMAILS.welcome.html, vars);
    expect(merged).not.toMatch(/\{\{[^}]+\}\}/);
    expect(merged).toContain('Maria');
    expect(merged).toContain('Abc-xyz123-4567');
  });
});
