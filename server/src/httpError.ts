export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  readonly headers: Record<string, string>;

  constructor(status: number, code: string, message: string, detail?: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.headers = headers;
  }
}
