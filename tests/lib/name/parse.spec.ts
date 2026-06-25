import { describe, expect, it } from 'vitest';
import { parseName } from '@/lib/name/parse';

describe('parseName', () => {
  it('returns empty parts for blank input', () => {
    expect(parseName('')).toEqual({ first_name: '', middle_name: '', last_name: '' });
    expect(parseName(null)).toEqual({ first_name: '', middle_name: '', last_name: '' });
    expect(parseName('   ')).toEqual({ first_name: '', middle_name: '', last_name: '' });
  });

  it('treats a single token as the first name', () => {
    expect(parseName('Juan')).toEqual({ first_name: 'Juan', middle_name: '', last_name: '' });
  });

  it('splits a simple two-token name into first + last (no middle)', () => {
    expect(parseName('Juan Cruz')).toEqual({
      first_name: 'Juan',
      middle_name: '',
      last_name: 'Cruz',
    });
  });

  it('uses the token before the surname as the maternal middle name', () => {
    expect(parseName('Juan Santos Cruz')).toEqual({
      first_name: 'Juan',
      middle_name: 'Santos',
      last_name: 'Cruz',
    });
  });

  it('keeps a multi-token first name, single middle, single last', () => {
    expect(parseName('Mery Angelyn Ann Calpa Dunan')).toEqual({
      first_name: 'Mery Angelyn Ann',
      middle_name: 'Calpa',
      last_name: 'Dunan',
    });
  });

  it('detects a single-token particle as the start of a compound surname', () => {
    expect(parseName('Hazzan dela Cruz')).toEqual({
      first_name: 'Hazzan',
      middle_name: '',
      last_name: 'dela Cruz',
    });
  });

  it('keeps a middle name before a compound surname', () => {
    expect(parseName('Juan Cruz dela Cruz')).toEqual({
      first_name: 'Juan',
      middle_name: 'Cruz',
      last_name: 'dela Cruz',
    });
  });

  it('handles two-token "de los" particles', () => {
    expect(parseName('Maria de los Santos')).toEqual({
      first_name: 'Maria',
      middle_name: '',
      last_name: 'de los Santos',
    });
  });

  it('binds the "Ma." prefix to the first name (no middle)', () => {
    expect(parseName('Ma. Luisa Marcelo')).toEqual({
      first_name: 'Ma. Luisa',
      middle_name: '',
      last_name: 'Marcelo',
    });
  });

  it('binds the "Jose" prefix to the first name', () => {
    expect(parseName('Jose Mari Chan')).toEqual({
      first_name: 'Jose Mari',
      middle_name: '',
      last_name: 'Chan',
    });
  });

  it('strips and normalises a Jr. suffix onto the surname', () => {
    expect(parseName('Juan Cruz Santos Jr')).toEqual({
      first_name: 'Juan',
      middle_name: 'Cruz',
      last_name: 'Santos Jr.',
    });
  });

  it('normalises a roman-numeral suffix to upper case', () => {
    expect(parseName('Juan Santos iii')).toEqual({
      first_name: 'Juan',
      middle_name: '',
      last_name: 'Santos III',
    });
  });

  it('title-cases ALL-CAPS bank-statement input and lowercases mid-name particles', () => {
    expect(parseName('JUAN DELA CRUZ')).toEqual({
      first_name: 'Juan',
      middle_name: '',
      last_name: 'dela Cruz',
    });
  });
});
