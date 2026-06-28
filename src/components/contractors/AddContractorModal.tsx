'use client';

import { type FormEvent, useState, useTransition } from 'react';
import { Modal, Spinner } from '@/components/ui';
import type { RosterWorker } from '@/db/queries/workers';
import { addContractor } from '@/server/actions/contractors';
import {
  CONTRACT_OPTIONS,
  type ContractType,
  PAY_BASIS_OPTIONS,
  type PayBasis,
} from '@/types/schemas/contractors';

type Props = {
  companyId: string;
  onClose: () => void;
  onCreated: (worker: RosterWorker) => void;
};

export function AddContractorModal({ companyId, onClose, onCreated }: Props) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [contract, setContract] = useState<ContractType>('FT');
  const [payBasis, setPayBasis] = useState<PayBasis | null>(null);
  const [error, setError] = useState('');
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!firstName.trim()) {
      setError('First name is required.');
      return;
    }
    if (!lastName.trim()) {
      setError('Last name is required.');
      return;
    }
    if (contract === 'PHS' && !payBasis) {
      setError('Choose a pay basis (per hour or per session) for a per-hour/session contract.');
      return;
    }
    setError('');

    startTransition(async () => {
      const result = await addContractor({
        companyId,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        contract,
        payBasis,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const workerId = result.data?.workerId ?? '';
      // Build a minimal RosterWorker shape so the caller can open the profile immediately.
      const worker: RosterWorker = {
        workerId,
        firstName: firstName.trim(),
        middleName: null,
        lastName: lastName.trim(),
        email: null,
        mobile: null,
        phAddress: null,
        permanentAddress: null,
        addressLandmark: null,
        postalCode: null,
        hireDate: null,
        workerStatus: 'active',
        payoutMethod: null,
        healthAllowanceEligible: true,
        thirteenthMonthEligible: true,
        workEmail: null,
        workNumber: null,
        workExtension: null,
        shiftStart: null,
        shiftEnd: null,
        dateOfBirth: null,
        emergencyName: null,
        emergencyRelationship: null,
        emergencyMobile: null,
        maritalStatus: null,
        educationLevel: null,
        course: null,
        yearGraduated: null,
        school: null,
        gcash: null,
        paymaya: null,
        paypal: null,
        wiseTag: null,
        wiseRecipientId: null,
        wiseRecipientUuid: null,
        photoUrl: null,
        linkId: '',
        companyId,
        contract,
        payBasis,
        role: null,
        hubstaffName: null,
        weeklyHours: null,
        billRateUsd: null,
        sessionRateUsd: null,
        linkStatus: 'active',
      };
      onCreated(worker);
    });
  }

  return (
    <Modal title="Add contractor" onClose={onClose} maxWidth={460}>
      <p className="sub" style={{ marginBottom: 16 }}>
        Creates a minimal record. Fill in the full profile in the next step.
      </p>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="ac-first">
            First name <span className="req">*</span>
          </label>
          <input
            id="ac-first"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder="First name"
            aria-invalid={error && !firstName.trim() ? 'true' : undefined}
            disabled={isPending}
          />
        </div>
        <div className="field">
          <label htmlFor="ac-last">
            Last name <span className="req">*</span>
          </label>
          <input
            id="ac-last"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Last name"
            aria-invalid={error && !lastName.trim() ? 'true' : undefined}
            disabled={isPending}
          />
        </div>
        <div className="field">
          <label htmlFor="ac-contract">Contract type</label>
          <select
            id="ac-contract"
            value={contract}
            onChange={(e) => {
              const next = e.target.value as ContractType;
              setContract(next);
              if (next !== 'PHS') setPayBasis(null);
            }}
            disabled={isPending}
          >
            {CONTRACT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label} ({o.value})
              </option>
            ))}
          </select>
        </div>
        {contract === 'PHS' && (
          <div className="field">
            <label htmlFor="ac-basis">
              Pay basis <span className="req">*</span>
            </label>
            <select
              id="ac-basis"
              value={payBasis ?? ''}
              onChange={(e) => setPayBasis((e.target.value || null) as PayBasis | null)}
              disabled={isPending}
            >
              <option value="">Select…</option>
              {PAY_BASIS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {error && (
          <div className="field-err" style={{ marginBottom: 8 }}>
            {error}
          </div>
        )}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={isPending}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={isPending}>
            {isPending ? <Spinner /> : 'Create & open profile'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
