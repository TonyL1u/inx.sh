/** An expected failure, sent to the client as `{ error: code }` with this HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** Extra fields sent next to `error`, e.g. the addresses a domain resolves to. */
    readonly details?: Record<string, unknown>
  ) {
    super(code);
  }
}
