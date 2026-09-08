export class RouterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RouterError';
    this.code = code;
  }
}
