export type ErrorCode =
  | 'INSUFFICIENT_BALANCE'
  | 'INVALID_DIMENSIONS'
  | 'DUPLICATE_REQUEST'
  | 'INVALID_TRANSITION'
  | 'HCM_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    public readonly detail?: string,
  ) {
    super(code);
  }
}
