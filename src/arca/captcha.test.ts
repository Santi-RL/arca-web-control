import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import type { Page } from "playwright";
import { pauseIfCaptcha } from "./captcha.js";
import { CaptchaRequiredError, captchaRequiredMarker, isCaptchaRequiredError } from "./captchaErrors.js";

function pageWithVisibleCaptcha(): Page {
  return {
    locator: () => ({
      first: () => ({ isVisible: async () => true }),
    }),
  } as unknown as Page;
}

test("el captcha siempre vuelve al controlador sin leer stdin", async () => {
  await assert.rejects(
    () => pauseIfCaptcha(pageWithVisibleCaptcha(), { manualIntervention: false }),
    (error: unknown) => error instanceof CaptchaRequiredError && error.code === captchaRequiredMarker,
  );
  await assert.rejects(
    () => pauseIfCaptcha(pageWithVisibleCaptcha()),
    (error: unknown) => isCaptchaRequiredError(error),
  );
  await assert.rejects(
    () => pauseIfCaptcha(pageWithVisibleCaptcha(), { manualIntervention: true }),
    (error: unknown) => isCaptchaRequiredError(error),
  );
});

test("la sesión desacoplada nunca habilita readline para resolver captchas", async () => {
  const source = await fs.readFile(new URL("./liveSession.ts", import.meta.url), "utf8");
  const captchaSource = await fs.readFile(new URL("./captcha.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /manualIntervention:\s*true/u);
  assert.doesNotMatch(source, /manualIntervention:\s*this\.options\.visibilityMode/u);
  assert.match(source, /manualIntervention:\s*false/u);
  assert.doesNotMatch(captchaSource, /readline|waitForEnter|io\/prompt/u);
});

test("la señal pública de captcha es estable y no contiene datos fiscales", () => {
  const error = new CaptchaRequiredError();
  assert.match(error.message, new RegExp(`^${captchaRequiredMarker}:`));
  assert.match(error.message, /no se reintentaron credenciales ni formularios/i);
  assert.doesNotMatch(error.message, /\d{11}/u);
});
