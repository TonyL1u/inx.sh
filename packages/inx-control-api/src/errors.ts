/** An expected failure, sent to the client as `{ error: code }` with this HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}
