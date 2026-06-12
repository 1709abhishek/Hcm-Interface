// apps/time-off-service/test/property/invariants.spec.ts
import fc from 'fast-check';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { buildTestApp } from '../utils';
import { RequestsService } from '../../src/requests/requests.service';
import { BalancesService } from '../../src/balances/balances.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { Balance, available } from '../../src/entities/balance.entity';
import { AppError } from '../../src/common/app-error';

const EMP = 'e1';
const LOC = 'l1';

type Op =
  | { kind: 'submit'; amount: number }
  | { kind: 'approve' } | { kind: 'deny' } | { kind: 'cancel' }
  | { kind: 'batchSync'; newBaseline: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant<'submit'>('submit'), amount: fc.integer({ min: 1, max: 5 }) }),
  fc.constant<Op>({ kind: 'approve' }),
  fc.constant<Op>({ kind: 'deny' }),
  fc.constant<Op>({ kind: 'cancel' }),
  fc.record({ kind: fc.constant<'batchSync'>('batchSync'), newBaseline: fc.integer({ min: 0, max: 30 }) }),
);

/** Trivially-correct reference model: same rules, no SQL, no transactions. */
class Model {
  baseline = 10; holds = 0; taken = 0;
  pending: { id: string; amount: number }[] = [];
  get available() { return this.baseline - this.taken - this.holds; }

  submit(id: string, amount: number): boolean {
    if (this.available < amount) return false;
    this.holds += amount;
    this.pending.push({ id, amount });
    return true;
  }
  takeFirstPending(): { id: string; amount: number } | undefined { return this.pending.shift(); }
  releaseHold(amount: number) { this.holds -= amount; }
  batchSync(newBaseline: number) { this.baseline = newBaseline; }
}

describe('invariants under random operation sequences', () => {
  jest.setTimeout(120_000);

  it('I1 (ledger == projection), I2 (no service-made negatives), model agreement', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 40 }), async (ops) => {
        const app: INestApplication = await buildTestApp();
        try {
          const requests = app.get(RequestsService);
          const balances = app.get(BalancesService);
          const ledger = app.get(LedgerService);
          const ds = app.get(DataSource);
          await balances.applyBatch([{ employeeId: EMP, locationId: LOC, balanceDays: 10 }]);
          const model = new Model();
          let seq = 0;

          for (const op of ops) {
            seq += 1;

            // Capture available before the op (for the corrected I2 check)
            const bBefore = await ds.manager.findOneByOrFail(Balance, { employeeId: EMP, locationId: LOC });
            const availableBeforeOp = available(bBefore);

            if (op.kind === 'submit') {
              const key = `pk-${seq}`;
              try {
                const req = await requests.submit({ employeeId: EMP, locationId: LOC, amountDays: op.amount }, key);
                const accepted = model.submit(req.id, op.amount);
                expect(accepted).toBe(true); // service accepted ⇒ model must agree
              } catch (e) {
                expect(e).toBeInstanceOf(AppError);
                expect(model.available).toBeLessThan(op.amount); // service rejected ⇒ model must agree
              }
            } else if (op.kind === 'approve' || op.kind === 'deny' || op.kind === 'cancel') {
              const target = model.takeFirstPending();
              if (!target) continue; // nothing pending — skip (no-op in both worlds)
              if (op.kind === 'approve') {
                await requests.approve(target.id, 'm1');
                // hold stays until dispatcher runs; model keeps the hold too: re-add as non-pending hold
                // (takeFirstPending already removed from pending array; holds remain unchanged)
              } else {
                if (op.kind === 'deny') await requests.deny(target.id, 'm1');
                else await requests.cancel(target.id);
                model.releaseHold(target.amount);
              }
            } else {
              // batchSync
              await balances.applyBatch([{ employeeId: EMP, locationId: LOC, balanceDays: op.newBaseline }]);
              model.batchSync(op.newBaseline);
            }

            // ---- invariants, checked after EVERY operation ----
            const b = await ds.manager.findOneByOrFail(Balance, { employeeId: EMP, locationId: LOC });
            const ledgerSum = await ledger.sumFor(ds.manager, EMP, LOC);

            // I1: ledger sum == available projection (within floating-point tolerance)
            expect(ledgerSum).toBeCloseTo(available(b), 9);

            // model agreement: service and model must always agree on available
            expect(available(b)).toBeCloseTo(model.available, 9);

            // I2: service-initiated ops never CREATE (or deepen) a negative balance.
            // A batch clawback may legitimately leave available < 0 (TRD §5 I2 exception);
            // after that, non-batch ops must never push it lower than where it stood.
            if (op.kind !== 'batchSync') {
              expect(available(b)).toBeGreaterThanOrEqual(Math.min(0, availableBeforeOp));
            }

            // holds and taken are always non-negative
            expect(b.pendingHolds).toBeGreaterThanOrEqual(0);
            expect(b.taken).toBeGreaterThanOrEqual(0);
          }
        } finally {
          await app.close();
        }
      }),
      { numRuns: 30 },
    );
  });
});
