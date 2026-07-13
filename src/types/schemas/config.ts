/**
 * Zod schemas for the Configuration page's employer/client save actions
 * (src/server/actions/config.ts). Kept out of that file because 'use server'
 * modules may only export async functions — this is also where every other
 * server-action trust boundary keeps its schema (see contractors.ts, payroll.ts).
 */

import { z } from 'zod';

export const ContactSchema = z.object({
  first_name: z.string().trim().optional().default(''),
  last_name: z.string().trim().optional().default(''),
  title: z.string().trim().optional().default(''),
  email: z.string().trim().optional().default(''),
  mobile: z.string().trim().optional().default(''),
  extension: z.string().trim().optional().default(''),
  fax: z.string().trim().optional().default(''),
});

export const CompanyFieldsSchema = z.object({
  name: z.string().trim().min(1, 'Company name is required.'),
  hubstaffOrgId: z
    .number()
    .int()
    .positive('Hubstaff org ID must be a positive number.')
    .nullable()
    .optional(),
  taxId: z.string().trim().nullable().optional(),
  address: z.string().trim().nullable().optional(),
  phone: z.string().trim().nullable().optional(),
  website: z.string().trim().nullable().optional(),
  contacts: z.array(ContactSchema).optional().default([]),
});
