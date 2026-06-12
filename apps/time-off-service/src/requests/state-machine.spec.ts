import { nextStatus, RequestAction } from './state-machine';
import { RequestStatus } from '../entities/time-off-request.entity';
import { AppError } from '../common/app-error';

const LEGAL: [RequestStatus, RequestAction, RequestStatus][] = [
  ['PENDING', 'approve', 'APPROVED'],
  ['PENDING', 'deny', 'DENIED'],
  ['PENDING', 'cancel', 'CANCELLED'],
  ['APPROVED', 'syncSucceed', 'SYNCED'],
  ['APPROVED', 'syncFail', 'SYNC_FAILED'],
];

const ALL_STATUSES: RequestStatus[] = ['PENDING', 'APPROVED', 'DENIED', 'CANCELLED', 'SYNCED', 'SYNC_FAILED'];
const ALL_ACTIONS: RequestAction[] = ['approve', 'deny', 'cancel', 'syncSucceed', 'syncFail'];

describe('state machine', () => {
  it.each(LEGAL)('%s --%s--> %s', (from, action, to) => {
    expect(nextStatus(from, action)).toBe(to);
  });

  it('rejects every transition not in the legal table with INVALID_TRANSITION', () => {
    const legalSet = new Set(LEGAL.map(([f, a]) => `${f}:${a}`));
    for (const from of ALL_STATUSES) {
      for (const action of ALL_ACTIONS) {
        if (legalSet.has(`${from}:${action}`)) continue;
        expect(() => nextStatus(from, action)).toThrow(AppError);
        try { nextStatus(from, action); } catch (e) {
          expect((e as AppError).code).toBe('INVALID_TRANSITION');
          expect((e as AppError).status).toBe(409);
        }
      }
    }
  });
});
