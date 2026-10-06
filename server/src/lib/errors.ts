// One error shape for every API response:
// { "error": { "code", "message", "details"?, "requestId" } }
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  validation: (details: unknown) => new AppError(400, "VALIDATION_FAILED", "Some fields are invalid.", details),
  unauthenticated: (message = "Please sign in.") => new AppError(401, "UNAUTHENTICATED", message),
  sessionExpired: () => new AppError(401, "SESSION_EXPIRED", "Your session has expired. Please sign in again."),
  invalidCredentials: () => new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect."),
  forbidden: (message = "You do not have permission to do this.") => new AppError(403, "FORBIDDEN", message),
  accountSuspended: () => new AppError(403, "ACCOUNT_SUSPENDED", "This account is suspended. Contact support."),
  notFound: (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found.`),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  invalidTransition: (message: string) => new AppError(422, "INVALID_TRANSITION", message),
  badToken: () => new AppError(400, "INVALID_TOKEN", "This link is invalid or has expired."),
};
