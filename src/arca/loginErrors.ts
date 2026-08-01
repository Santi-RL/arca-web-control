import { captchaRequiredErrorFromLog } from "./captchaErrors.js";

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
  return invalidCredentialsErrorFromLog(log)
    ?? captchaRequiredErrorFromLog(log)
    ?? credentialProviderErrorFromLog(log)
    ?? new Error(fallback);
}

export function invalidCredentialsErrorFromLog(log: string): InvalidArcaCredentialsError | undefined {
  return log.includes(invalidArcaCredentialsMarker) ? new InvalidArcaCredentialsError() : undefined;
}

export function credentialProviderErrorFromLog(log: string): Error | undefined {
  if (log.includes("ARCA_CREDENTIAL_PROVIDER_UNAVAILABLE")) {
    return new Error("ARCA_CREDENTIAL_PROVIDER_UNAVAILABLE: No se pudo consultar de forma segura el proveedor de credenciales configurado.");
  }
  if (log.includes("ARCA_CREDENTIAL_AMBIGUOUS")) {
    return new Error("ARCA_CREDENTIAL_AMBIGUOUS: El emisor corresponde a más de un CUIT; resolvelo nuevamente desde el índice no secreto.");
  }
  if (log.includes("ARCA_CREDENTIAL_CONFIRMATION_REQUIRED")) {
    return new Error("ARCA_CREDENTIAL_CONFIRMATION_REQUIRED: El emisor requiere confirmar un candidato antes de iniciar sesión.");
  }
  if (log.includes("ARCA_CREDENTIAL_NOT_FOUND")) {
    return new Error("ARCA_CREDENTIAL_NOT_FOUND: No existe una credencial exacta para el emisor indicado.");
  }
  return undefined;
}
