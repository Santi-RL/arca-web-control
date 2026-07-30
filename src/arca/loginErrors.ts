export const invalidArcaCredentialsMarker = "ARCA_INVALID_CREDENTIALS";

export class InvalidArcaCredentialsError extends Error {
  readonly code = invalidArcaCredentialsMarker;

  constructor() {
    super(`${invalidArcaCredentialsMarker}: ARCA informó "Clave o usuario incorrecto". Se detuvo el login sin reintentar.`);
    this.name = "InvalidArcaCredentialsError";
  }
}

export function isInvalidArcaCredentialsMessage(value: string): boolean {
  return /\bclave\s+o\s+usuario\s+incorrecto\b/i.test(value.normalize("NFC"));
}

export function startupErrorFromLog(log: string, fallback: string): Error {
  return invalidCredentialsErrorFromLog(log) ?? new Error(fallback);
}

export function invalidCredentialsErrorFromLog(log: string): InvalidArcaCredentialsError | undefined {
  return log.includes(invalidArcaCredentialsMarker) ? new InvalidArcaCredentialsError() : undefined;
}
