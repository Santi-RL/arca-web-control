import { AuthenticationAttemptGate } from "../arca/authenticationAttemptGate.js";
import { isCaptchaRequiredError } from "../arca/captchaErrors.js";
import { InvalidArcaCredentialsError } from "../arca/loginErrors.js";
import { isOfficialArcaAuthUrl, isOfficialArcaPortalUrl } from "../arca/officialUrls.js";

export type LearningAuthenticationOutcome = "captcha" | "portal" | "unexpected";

export type LearningAuthenticationResume = {
  gate: AuthenticationAttemptGate;
  isCaptchaVisible: () => Promise<boolean>;
  currentUrl: () => string;
  continueAccess: () => Promise<void>;
};

/**
 * Reanuda únicamente una pausa por captcha ya reconocida. La función nunca
 * actúa mientras el captcha siga visible ni sobre una pantalla que no sea el
 * login oficial; una credencial rechazada clausura la compuerta antes de
 * propagar el error.
 */
export async function resumeLearningAuthentication(input: LearningAuthenticationResume): Promise<LearningAuthenticationOutcome> {
  input.gate.assertResumeAllowed();

  if (await input.isCaptchaVisible()) return "captcha";

  const initialUrl = input.currentUrl();
  if (isOfficialArcaPortalUrl(initialUrl)) {
    input.gate.markResumed();
    return "portal";
  }
  if (!isOfficialArcaAuthUrl(initialUrl)) return "unexpected";

  try {
    await input.continueAccess();
  } catch (error) {
    if (error instanceof InvalidArcaCredentialsError) input.gate.markRejected();
    if (isCaptchaRequiredError(error)) {
      input.gate.markCaptchaRequired();
      return "captcha";
    }
    throw error;
  }

  if (await input.isCaptchaVisible()) {
    input.gate.markCaptchaRequired();
    return "captcha";
  }
  if (!isOfficialArcaPortalUrl(input.currentUrl())) return "unexpected";

  input.gate.markResumed();
  return "portal";
}
