import type { ContractType } from '@/types/schemas/contractors';

/** The contractor profile edit form (all string-backed for controlled inputs). */
export type FormState = {
  firstName: string;
  middleName: string;
  lastName: string;
  email: string;
  workEmail: string;
  mobile: string;
  workNumber: string;
  workExtension: string;
  hireDate: string;
  dateOfBirth: string;
  phAddress: string;
  permanentAddress: string;
  addressLandmark: string;
  postalCode: string;
  payoutMethod: string;
  healthAllowanceEligible: boolean;
  thirteenthMonthEligible: boolean;
  contract: ContractType;
  role: string;
  hubstaffName: string;
  weeklyHours: string;
  billRateUsd: string;
  sessionRateUsd: string;
  linkStatus: 'active' | 'inactive' | 'ended';
  shiftStart: string;
  shiftEnd: string;
  emergencyName: string;
  emergencyRelationship: string;
  emergencyMobile: string;
  maritalStatus: string;
  educationLevel: string;
  course: string;
  yearGraduated: string;
  school: string;
  gcash: string;
  paymaya: string;
  paypal: string;
  wiseTag: string;
};

/** Field-update setter the shell hands to each tab panel. */
export type SetField = <K extends keyof FormState>(key: K, value: FormState[K]) => void;

/** Field-level validation errors, keyed by form field. */
export type FormErrors = Partial<Record<keyof FormState, string>>;

/** Shared tab-panel props the shell threads to each editable tab. */
export interface ProfileTabProps {
  form: FormState;
  set: SetField;
  errors: FormErrors;
  isPending: boolean;
  serverError: string;
  onSubmit: (e: React.FormEvent) => void;
  /** Spread of the shell's tablist.panelProps() — marks the form as the active tabpanel. */
  panelProps: { role: 'tabpanel'; id: string; 'aria-labelledby': string; tabIndex: number };
}

/** Section header styling shared across the editable tabs. */
export const SECTION_H4: React.CSSProperties = {
  margin: '0 0 12px',
  fontSize: 13,
  textTransform: 'uppercase',
  letterSpacing: '.05em',
  color: 'var(--muted)',
};
