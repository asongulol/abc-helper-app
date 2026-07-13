import { describe, expect, it } from 'vitest';
import { MAX_FIELD_LEN, validateProfileFields } from '@/lib/profile/validate';

describe('validateProfileFields', () => {
  it('accepts a well-formed patch', () => {
    expect(
      validateProfileFields({
        first_name: 'Maria',
        mobile: '+63 917-123-4567',
        emergency_mobile: '09171234567',
        ph_address: '123 Rizal St, Quezon City',
      }),
    ).toBeNull();
  });

  it('rejects a non-phone mobile (#017)', () => {
    expect(validateProfileFields({ mobile: 'abc-not-a-phone!!' })).toMatch(/valid phone/i);
  });

  it('rejects a too-short phone', () => {
    expect(validateProfileFields({ emergency_mobile: '12345' })).toMatch(/valid phone/i);
  });

  it('rejects over-long free text (#041)', () => {
    expect(validateProfileFields({ motto: '🎉'.repeat(315) })).toMatch(/too long/i);
  });

  it('allows clearing a field (empty string is not validated)', () => {
    expect(validateProfileFields({ mobile: '', motto: '   ' })).toBeNull();
  });

  it('allows text right at the length cap', () => {
    expect(validateProfileFields({ motto: 'a'.repeat(MAX_FIELD_LEN) })).toBeNull();
  });
});
