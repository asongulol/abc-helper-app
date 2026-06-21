'use client';

import { Modal } from '@/components/ui';
import type { OnboardingProgressRow } from '@/db/queries/onboarding';
import { OnboardingDetailBody } from './OnboardingDetailBody';

interface Props {
  row: OnboardingProgressRow;
  canCountersign: boolean;
  isOwner: boolean;
  onClose: () => void;
}

/**
 * Onboarding review as an overlay modal — mounted by the intercept route
 * (`@modal/(.)[workerId]`) on soft navigation. Hard navigation renders
 * `OnboardingDetailPage` instead. Both share `OnboardingDetailBody`.
 */
export const OnboardingDrilldown = ({ row, canCountersign, isOwner, onClose }: Props) => {
  return (
    <Modal title={`Onboarding — ${row.workerName}`} onClose={onClose} maxWidth={580}>
      <OnboardingDetailBody
        row={row}
        canCountersign={canCountersign}
        isOwner={isOwner}
        onClose={onClose}
      />
    </Modal>
  );
};
