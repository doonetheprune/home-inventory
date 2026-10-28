/**
 * Errors the core throws on purpose. The server maps `status` to the HTTP
 * response code and shows `message` to the person using the app, so write
 * messages that say what went wrong and how to fix it.
 */
export class LarderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LarderError';
  }
}

export class NotFoundError extends LarderError {
  constructor(what: string, id: string) {
    super(`${what} ${id} doesn't exist. It may have been deleted.`, 404, 'not_found');
  }
}

export class ValidationError extends LarderError {
  constructor(message: string) {
    super(message, 400, 'invalid');
  }
}

export class ConflictError extends LarderError {
  constructor(message: string) {
    super(message, 409, 'conflict');
  }
}
