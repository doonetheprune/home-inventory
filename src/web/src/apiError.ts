/** An error from Larder (or from a saved copy), with a message written for people. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}
