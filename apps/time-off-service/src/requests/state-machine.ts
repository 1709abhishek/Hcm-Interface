import { RequestStatus } from '../entities/time-off-request.entity';
import { AppError } from '../common/app-error';

export type RequestAction =
  | 'approve'
  | 'deny'
  | 'cancel'
  | 'syncSucceed'
  | 'syncFail';

const TRANSITIONS: Partial<
  Record<RequestStatus, Partial<Record<RequestAction, RequestStatus>>>
> = {
  PENDING: { approve: 'APPROVED', deny: 'DENIED', cancel: 'CANCELLED' },
  APPROVED: { syncSucceed: 'SYNCED', syncFail: 'SYNC_FAILED' },
};

export function nextStatus(
  from: RequestStatus,
  action: RequestAction,
): RequestStatus {
  const to = TRANSITIONS[from]?.[action];
  if (!to)
    throw new AppError(
      'INVALID_TRANSITION',
      409,
      `cannot ${action} a ${from} request`,
    );
  return to;
}
