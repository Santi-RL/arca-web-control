import { InvalidArcaCredentialsError } from "./loginErrors.js";
import { CaptchaRequiredError } from "./captchaErrors.js";

export class AuthenticationAttemptGate {
  private rejected = false;
  private pausedForCaptcha = false;

  assertAllowed(): void {
    if (this.rejected) throw new InvalidArcaCredentialsError();
  }

  assertMutationAllowed(): void {
    this.assertAllowed();
    if (this.pausedForCaptcha) throw new CaptchaRequiredError();
  }

  markRejected(): void {
    this.rejected = true;
  }

  markCaptchaRequired(): void {
    this.pausedForCaptcha = true;
  }

  isPausedForCaptcha(): boolean {
    return this.pausedForCaptcha;
  }

  assertResumeAllowed(): void {
    this.assertAllowed();
    if (!this.pausedForCaptcha) {
      throw new Error("resume-authentication solo se admite después de que la sesión haya detectado y señalado un captcha.");
    }
  }

  markResumed(): void {
    this.pausedForCaptcha = false;
  }
}
