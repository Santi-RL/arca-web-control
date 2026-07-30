export const captchaRequiredMarker = "ARCA_CAPTCHA_REQUIRED";

const captchaRequiredMessage = `${captchaRequiredMarker}: ARCA solicitó un captcha. Se requiere intervención humana; no se reintentaron credenciales ni formularios.`;

export class CaptchaRequiredError extends Error {
  readonly code = captchaRequiredMarker;

  constructor() {
    super(captchaRequiredMessage);
    this.name = "CaptchaRequiredError";
  }
}

export function isCaptchaRequiredError(error: unknown): error is CaptchaRequiredError {
  return error instanceof CaptchaRequiredError
    || (error instanceof Error && error.message.includes(captchaRequiredMarker));
}

export function captchaRequiredErrorFromLog(log: string): CaptchaRequiredError | undefined {
  return log.includes(captchaRequiredMarker) ? new CaptchaRequiredError() : undefined;
}
