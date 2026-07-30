import { Page } from "playwright";
import { ArcaCredentials, RuntimeConfig } from "../types.js";
import { isCaptchaVisible, pauseIfCaptcha } from "./captcha.js";
import { FlowContext } from "./flowContext.js";
import { candidate, clickFirstVisible, fillFirstVisible, waitForPageSettled } from "./pageHelpers.js";
import { InvalidArcaCredentialsError } from "./loginErrors.js";
import { measureArcaPerformance } from "./performance.js";
import { assertOfficialArcaAuthUrl, isOfficialArcaAuthUrl, isOfficialArcaPortalUrl } from "./officialUrls.js";

const loginOutcomeTimeoutMs = 60_000;
type LoginExpectedOutcome = "password" | "portal" | "auth-exit";

export async function loginToArca(page: Page, config: RuntimeConfig, credentials: ArcaCredentials, context?: FlowContext): Promise<void> {
  console.log("Abriendo login de ARCA...");
  await measureArcaPerformance("login_open_page", async () => {
    assertOfficialArcaAuthUrl(config.loginUrl, "la apertura del login fiscal");
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded" });
    await pauseIfCaptcha(page, context);
  });
  await context?.guided?.checkpoint(page, {
    title: "Login de ARCA cargado",
    expected: "Debe verse la pantalla oficial de ARCA para ingresar CUIT/CUIL.",
    nextAction: "El sistema ingresara el CUIT del emisor configurado.",
  });

  console.log("Ingresando CUIT...");
  await measureArcaPerformance("login_submit_identity", async () => {
    assertOfficialArcaAuthUrl(page.url(), "el ingreso del CUIT");
    await fillFirstVisible([
      candidate(page.getByLabel(/cuit|cuil|clave unica/i), "campo por label CUIT/CUIL"),
      candidate(page.getByPlaceholder(/cuit|cuil/i), "campo por placeholder CUIT/CUIL"),
      candidate(page.locator("input[name='F1:username']"), "input name exacto F1:username"),
      candidate(page.locator("input[id='F1:username']"), "input id exacto F1:username"),
      candidate(page.locator("input[autocomplete='username']"), "input autocomplete username"),
      candidate(page.locator("input[type='number']").first(), "primer input numerico visible"),
      candidate(page.locator("input[type='text']").first(), "primer input texto visible"),
    ], credentials.cuit, "CUIT", context);

    assertOfficialArcaAuthUrl(page.url(), "el envío del CUIT");
    await clickFirstVisible([
      candidate(page.getByRole("button", { name: /siguiente|continuar|ingresar/i }), "boton siguiente/continuar/ingresar"),
      candidate(page.locator("input[type='submit']"), "input submit"),
      candidate(page.locator("button[type='submit']"), "button submit"),
    ], "continuar despues de CUIT", context);
    await waitForPageSettled(page);
    await waitForLoginOutcome(page, "password", context);
  });
  await context?.guided?.checkpoint(page, {
    title: "Paso de clave fiscal cargado",
    expected: "Debe verse el campo de clave fiscal para el mismo CUIT.",
    nextAction: "El sistema ingresara la clave fiscal sin imprimirla en consola.",
  });

  console.log("Ingresando clave fiscal...");
  await measureArcaPerformance("login_submit_secret", async () => {
    assertOfficialArcaAuthUrl(page.url(), "el ingreso de la clave fiscal");
    await fillFirstVisible([
      candidate(page.getByLabel(/clave/i), "campo por label clave"),
      candidate(page.getByPlaceholder(/clave/i), "campo por placeholder clave"),
      candidate(page.locator("input[type='password']"), "input password"),
    ], credentials.clave, "clave fiscal", context);

  await context?.guided?.checkpoint(page, {
    title: "Clave fiscal cargada",
    expected: "Debe verse la pantalla de clave fiscal lista para ingresar. La clave no debe mostrarse en texto claro.",
    nextAction: "El sistema hara click en Ingresar.",
  });

    assertOfficialArcaAuthUrl(page.url(), "el envío de la clave fiscal");
    await clickFirstVisible([
      candidate(page.getByRole("button", { name: /ingresar|continuar|siguiente/i }), "boton ingresar/continuar/siguiente"),
      candidate(page.locator("input[type='submit']"), "input submit"),
      candidate(page.locator("button[type='submit']"), "button submit"),
    ], "ingresar", context);
    await waitForPageSettled(page);
    await waitForLoginOutcome(page, "portal", context);
  });
  await context?.guided?.checkpoint(page, {
    title: "Sesion iniciada",
    expected: "Debe verse el portal de ARCA ya autenticado, antes de entrar a Comprobantes en Linea.",
    nextAction: "El sistema buscara el servicio Comprobantes en Linea.",
  });
}

export async function continueArcaAccessIfRequested(page: Page, credentials: ArcaCredentials, context?: FlowContext): Promise<void> {
  await waitForPageSettled(page);
  await pauseIfCaptcha(page, context);
  assertOfficialArcaAuthUrl(page.url(), "la continuación del acceso fiscal");

  const cuitField = page.getByLabel(/cuit|cuil|clave unica/i)
    .or(page.getByPlaceholder(/cuit|cuil/i))
    .or(page.locator("input[name='F1:username']"))
    .or(page.locator("input[id='F1:username']"))
    .or(page.locator("input[autocomplete='username']"));

  if (await cuitField.first().isVisible().catch(() => false)) {
    console.log("Confirmando CUIT...");
    assertOfficialArcaAuthUrl(page.url(), "el ingreso del CUIT");
    await fillFirstVisible([
      candidate(page.getByLabel(/cuit|cuil|clave unica/i), "campo por label CUIT/CUIL"),
      candidate(page.getByPlaceholder(/cuit|cuil/i), "campo por placeholder CUIT/CUIL"),
      candidate(page.locator("input[name='F1:username']"), "input name exacto F1:username"),
      candidate(page.locator("input[id='F1:username']"), "input id exacto F1:username"),
      candidate(page.locator("input[autocomplete='username']"), "input autocomplete username"),
      candidate(page.locator("input[type='number']").first(), "primer input numerico visible"),
      candidate(page.locator("input[type='text']").first(), "primer input texto visible"),
    ], credentials.cuit, "CUIT", context);

    assertOfficialArcaAuthUrl(page.url(), "el envío del CUIT");
    await clickFirstVisible([
      candidate(page.getByRole("button", { name: /siguiente|continuar|ingresar/i }), "boton siguiente/continuar/ingresar"),
      candidate(page.locator("input[type='submit']"), "input submit"),
      candidate(page.locator("button[type='submit']"), "button submit"),
    ], "continuar despues de CUIT", context);
    await waitForPageSettled(page);
    await waitForLoginOutcome(page, "password", context);
  }

  const passwordField = page.getByLabel(/clave/i)
    .or(page.getByPlaceholder(/clave/i))
    .or(page.locator("input[type='password']"));

  if (await passwordField.first().isVisible().catch(() => false)) {
    console.log("Confirmando clave fiscal...");
    assertOfficialArcaAuthUrl(page.url(), "el ingreso de la clave fiscal");
    await fillFirstVisible([
      candidate(page.getByLabel(/clave/i), "campo por label clave"),
      candidate(page.getByPlaceholder(/clave/i), "campo por placeholder clave"),
      candidate(page.locator("input[type='password']"), "input password"),
    ], credentials.clave, "clave fiscal", context);
  }

  const submitButton = page.getByRole("button", { name: /ingresar|continuar|siguiente|aceptar/i })
    .or(page.locator("input[type='submit']"))
    .or(page.locator("button[type='submit']"));

  if (await submitButton.first().isVisible().catch(() => false)) {
    assertOfficialArcaAuthUrl(page.url(), "el envío del formulario de autenticación");
    await clickFirstVisible([
      candidate(page.getByRole("button", { name: /ingresar|continuar|siguiente|aceptar/i }), "boton ingresar/continuar/siguiente/aceptar"),
      candidate(page.locator("input[type='submit']"), "input submit"),
      candidate(page.locator("button[type='submit']"), "button submit"),
    ], "continuar acceso ARCA", context);
    await waitForPageSettled(page);
    await waitForLoginOutcome(page, "auth-exit", context);
  }
}

async function waitForLoginOutcome(page: Page, expected: LoginExpectedOutcome, context?: FlowContext): Promise<void> {
  let deadline = Date.now() + loginOutcomeTimeoutMs;

  while (Date.now() < deadline) {
    const rejected = await page.getByText(/clave\s+o\s+usuario\s+incorrecto/i, { exact: false }).first().isVisible().catch(() => false);
    if (rejected) throw new InvalidArcaCredentialsError();

    if (await loginOutcomeReached(page, expected)) return;

    if (await isCaptchaVisible(page)) {
      await pauseIfCaptcha(page, context);
      deadline = Date.now() + loginOutcomeTimeoutMs;
      continue;
    }

    await page.waitForTimeout(250);
  }

  throw new Error(`ARCA no confirmó el resultado esperado del login (${expected}). Se detuvo el acceso sin reintentar.`);
}

async function loginOutcomeReached(page: Page, expected: LoginExpectedOutcome): Promise<boolean> {
  const url = page.url();
  if (expected === "password") {
    assertOfficialArcaAuthUrl(url, "la espera del paso de clave fiscal");
    return page.locator("input[type='password']").first().isVisible().catch(() => false);
  }

  if (expected === "portal") {
    if (isOfficialArcaPortalUrl(url)) return true;
    if (!isOfficialArcaAuthUrl(url)) {
      throw new Error("ARCA_UNTRUSTED_LOGIN_DESTINATION: el login no finalizó en el Portal de Clave Fiscal oficial.");
    }
    return false;
  }

  return !isOfficialArcaAuthUrl(url);
}
