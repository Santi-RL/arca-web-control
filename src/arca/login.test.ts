import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { credentialProviderErrorFromLog, InvalidArcaCredentialsError, invalidCredentialsErrorFromLog, isInvalidArcaCredentialsMessage, startupErrorFromLog } from "./loginErrors.js";
import { CaptchaRequiredError } from "./captchaErrors.js";
import { continueArcaAccessIfRequested } from "./login.js";

test("reconoce el rechazo explícito de credenciales de ARCA", () => {
  assert.equal(isInvalidArcaCredentialsMessage("Clave o usuario incorrecto"), true);
  assert.equal(isInvalidArcaCredentialsMessage("  CLAVE   O USUARIO   INCORRECTO  "), true);
  assert.equal(isInvalidArcaCredentialsMessage("Ingresar con Clave Fiscal"), false);
});

test("el launcher traduce el marcador sin exponer datos ni sugerir reintento", () => {
  const error = startupErrorFromLog(`stack\n${new InvalidArcaCredentialsError().message}\n`, "fallback");
  assert.ok(error instanceof InvalidArcaCredentialsError);
  assert.match(error.message, /sin reintentar/);
  assert.doesNotMatch(error.message, /\d{11}/);
});

test("un log sin rechazo explícito no se interpreta como credencial inválida", () => {
  assert.equal(invalidCredentialsErrorFromLog("Timeout iniciando aprendizaje."), undefined);
});

test("el launcher traduce errores del proveedor sin copiar el contenido privado del log", () => {
  const sentinel = ["valor", "centinela", "no-real"].join("-");
  for (const marker of [
    "ARCA_CREDENTIAL_PROVIDER_UNAVAILABLE",
    "ARCA_CREDENTIAL_AMBIGUOUS",
    "ARCA_CREDENTIAL_CONFIRMATION_REQUIRED",
    "ARCA_CREDENTIAL_NOT_FOUND",
  ]) {
    const error = credentialProviderErrorFromLog(`stack ${marker} ${sentinel}`);
    assert.ok(error);
    assert.match(error.message, new RegExp(marker));
    assert.doesNotMatch(error.message, new RegExp(sentinel));
  }
});

test("el launcher reconstruye una señal tipada y sanitizada de captcha", () => {
  const error = startupErrorFromLog(`stack\n${new CaptchaRequiredError().message}\n`, "fallback");
  assert.ok(error instanceof CaptchaRequiredError);
  assert.match(error.message, /intervención humana/i);
  assert.match(error.message, /no se reintentaron/i);
  assert.doesNotMatch(error.message, /\d{11}/u);
});

test("la continuación no acciona un submit genérico si no reconoce una etapa de autenticación", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const url = "https://auth.afip.gob.ar/contribuyente_/login.xhtml";
    await page.route(url, (route) => route.fulfill({
      contentType: "text/html",
      body: `<button type="submit" onclick="window.submitCount=(window.submitCount||0)+1">Aceptar</button>`,
    }));
    await page.goto(url);
    await assert.rejects(
      () => continueArcaAccessIfRequested(page, syntheticCredentials()),
      /pantalla de autenticación inesperada.*no se envió/i,
    );
    assert.equal(await page.evaluate(() => (window as typeof window & { submitCount?: number }).submitCount ?? 0), 0);
  } finally {
    await browser.close();
  }
});

test("un rechazo ya visible clausura la continuación antes de rellenar o enviar la clave", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const url = "https://auth.afip.gob.ar/contribuyente_/login.xhtml";
    await page.route(url, (route) => route.fulfill({
      contentType: "text/html",
      body: `<p>Clave o usuario incorrecto</p><input type="password" value="sin-cambios"><button type="submit" onclick="window.submitCount=(window.submitCount||0)+1">Ingresar</button>`,
    }));
    await page.goto(url);
    await assert.rejects(() => continueArcaAccessIfRequested(page, syntheticCredentials()), InvalidArcaCredentialsError);
    assert.equal(await page.locator("input[type='password']").inputValue(), "sin-cambios");
    assert.equal(await page.evaluate(() => (window as typeof window & { submitCount?: number }).submitCount ?? 0), 0);
  } finally {
    await browser.close();
  }
});

function syntheticCredentials() {
  return {
    issuerKey: "20000000001",
    cuit: "20000000001",
    displayName: "Emisor ficticio",
    clave: ["clave", "ficticia"].join("-"),
  };
}
