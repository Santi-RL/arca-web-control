import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationAttemptGate } from "../arca/authenticationAttemptGate.js";
import { CaptchaRequiredError } from "../arca/captchaErrors.js";
import { InvalidArcaCredentialsError } from "../arca/loginErrors.js";
import { resumeLearningAuthentication } from "./authentication.js";

const authUrl = "https://auth.afip.gob.ar/contribuyente_/login.xhtml";
const portalUrl = "https://portalcf.cloud.afip.gob.ar/portal/app/";

function pausedGate(): AuthenticationAttemptGate {
  const gate = new AuthenticationAttemptGate();
  gate.markCaptchaRequired();
  return gate;
}

test("no reenvía el login mientras el captcha sigue visible", async () => {
  const gate = pausedGate();
  let continuationCount = 0;
  const outcome = await resumeLearningAuthentication({
    gate,
    isCaptchaVisible: async () => true,
    currentUrl: () => authUrl,
    continueAccess: async () => { continuationCount += 1; },
  });

  assert.equal(outcome, "captcha");
  assert.equal(continuationCount, 0);
  assert.equal(gate.isPausedForCaptcha(), true);
});

test("acepta la resolución manual que ya llegó al portal sin reenviar formularios", async () => {
  const gate = pausedGate();
  let continuationCount = 0;
  const outcome = await resumeLearningAuthentication({
    gate,
    isCaptchaVisible: async () => false,
    currentUrl: () => portalUrl,
    continueAccess: async () => { continuationCount += 1; },
  });

  assert.equal(outcome, "portal");
  assert.equal(continuationCount, 0);
  assert.equal(gate.isPausedForCaptcha(), false);
});

test("una reanudación explícita continúa una sola vez desde el login oficial", async () => {
  const gate = pausedGate();
  let url = authUrl;
  let continuationCount = 0;
  const outcome = await resumeLearningAuthentication({
    gate,
    isCaptchaVisible: async () => false,
    currentUrl: () => url,
    continueAccess: async () => { continuationCount += 1; url = portalUrl; },
  });

  assert.equal(outcome, "portal");
  assert.equal(continuationCount, 1);
  assert.equal(gate.isPausedForCaptcha(), false);
});

test("una credencial rechazada impide un segundo intento", async () => {
  const gate = pausedGate();
  let continuationCount = 0;
  const input = {
    gate,
    isCaptchaVisible: async () => false,
    currentUrl: () => authUrl,
    continueAccess: async () => { continuationCount += 1; throw new InvalidArcaCredentialsError(); },
  };

  await assert.rejects(() => resumeLearningAuthentication(input), InvalidArcaCredentialsError);
  await assert.rejects(() => resumeLearningAuthentication(input), InvalidArcaCredentialsError);
  assert.equal(continuationCount, 1);
});

test("un nuevo captcha conserva la pausa y una pantalla inesperada no se muta", async () => {
  const captchaGate = pausedGate();
  const captchaOutcome = await resumeLearningAuthentication({
    gate: captchaGate,
    isCaptchaVisible: async () => false,
    currentUrl: () => authUrl,
    continueAccess: async () => { throw new CaptchaRequiredError(); },
  });
  assert.equal(captchaOutcome, "captcha");
  assert.equal(captchaGate.isPausedForCaptcha(), true);

  const unexpectedGate = pausedGate();
  let continuationCount = 0;
  const unexpectedOutcome = await resumeLearningAuthentication({
    gate: unexpectedGate,
    isCaptchaVisible: async () => false,
    currentUrl: () => "https://example.invalid/",
    continueAccess: async () => { continuationCount += 1; },
  });
  assert.equal(unexpectedOutcome, "unexpected");
  assert.equal(continuationCount, 0);
  assert.equal(unexpectedGate.isPausedForCaptcha(), true);
});
