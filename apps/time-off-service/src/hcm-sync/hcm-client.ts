// apps/time-off-service/src/hcm-sync/hcm-client.ts
import { Injectable } from '@nestjs/common';

export class HcmUnavailableError extends Error {}

export interface DeductionPayload { idempotencyKey: string; employeeId: string; locationId: string; amountDays: number; }
export interface HcmBatchEntry { employeeId: string; locationId: string; balanceDays: number; }
export type DeductionResponse = { ok: true } | { ok: false; code: string };

@Injectable()
export class HcmClient {
  constructor(
    private readonly baseUrl: string = process.env.HCM_BASE_URL ?? 'http://localhost:3001',
    private readonly timeoutMs: number = Number(process.env.HCM_TIMEOUT_MS ?? 2000),
  ) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new HcmUnavailableError(`HCM unreachable: ${String(e)}`);
    }
  }

  async getBalance(employeeId: string, locationId: string): Promise<number | null> {
    const res = await this.request(`/balances/${employeeId}/${locationId}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new HcmUnavailableError(`HCM ${res.status}`);
    return (await res.json()).balanceDays as number;
  }

  /** 4xx with a code is an HCM *decision* (returned); 5xx/network is unavailability (thrown). */
  async postDeduction(payload: DeductionPayload): Promise<DeductionResponse> {
    const res = await this.request('/deductions', { method: 'POST', body: JSON.stringify(payload) });
    if (res.ok) return { ok: true };
    if (res.status >= 400 && res.status < 500) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, code: body.code ?? `HCM_${res.status}` };
    }
    throw new HcmUnavailableError(`HCM ${res.status}`);
  }

  async hasDeduction(idempotencyKey: string): Promise<boolean> {
    const res = await this.request(`/deductions/${idempotencyKey}`);
    if (res.status === 404) return false;
    if (!res.ok) throw new HcmUnavailableError(`HCM ${res.status}`);
    return true;
  }

  async getBatch(): Promise<HcmBatchEntry[]> {
    const res = await this.request('/batch');
    if (!res.ok) throw new HcmUnavailableError(`HCM ${res.status}`);
    return (await res.json()).balances as HcmBatchEntry[];
  }
}
