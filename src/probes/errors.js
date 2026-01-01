export class HttpError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function bad(statusCode, message, code) {
  return new HttpError(statusCode, message, code);
}
