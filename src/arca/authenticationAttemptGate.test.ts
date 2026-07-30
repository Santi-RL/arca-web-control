import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationAttemptGate } from "./authenticationAttemptGate.js";
import { InvalidArcaCredentialsError } from "./loginErrors.js";

test("una credencial rechazada bloquea de forma durable todo segundo intento en la sesión", () => {
  const gate = new AuthenticationAttemptGate();
  assert.doesNotThrow(() => gate.assertAllowed());
  gate.markRejected();
  assert.throws(() => gate.assertAllowed(), InvalidArcaCredentialsError);
  assert.throws(() => gate.assertAllowed(), /sin reintentar/i);
});

test("la reanudación solo se habilita después de una pausa real por captcha", () => {
  const gate = new AuthenticationAttemptGate();
  assert.throws(() => gate.assertResumeAllowed(), /después.*captcha/i);
  gate.markCaptchaRequired();
  assert.equal(gate.isPausedForCaptcha(), true);
  assert.doesNotThrow(() => gate.assertResumeAllowed());
  assert.throws(() => gate.assertMutationAllowed(), /ARCA_CAPTCHA_REQUIRED/);
  gate.markResumed();
  assert.equal(gate.isPausedForCaptcha(), false);
  assert.doesNotThrow(() => gate.assertMutationAllowed());
  assert.throws(() => gate.assertResumeAllowed(), /después.*captcha/i);
});
