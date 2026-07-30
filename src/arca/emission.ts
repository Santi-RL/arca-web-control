import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Page } from "playwright";
import { waitForPageSettled } from "./pageHelpers.js";
import { assertOfficialArcaRcelUrl } from "./officialUrls.js";

export type EmissionResult = {
  voucherNumber?: string;
  cae?: string;
  bodyText: string;
};

export async function executeControlledEmission(page: Page, options: { onIrreversible?: () => Promise<void> } = {}): Promise<EmissionResult> {
  assertOfficialArcaRcelUrl(page.url(), "la lectura del resumen previo a emitir");
  const confirmData = await assertUnique(page.getByRole("button", { name: /Confirmar Datos/i }).or(page.getByRole("link", { name: /Confirmar Datos/i })), "Confirmar Datos");
  await options.onIrreversible?.();
  assertOfficialArcaRcelUrl(page.url(), "la confirmación de los datos");
  await confirmData.click();
  await waitForPageSettled(page);
  assertOfficialArcaRcelUrl(page.url(), "la lectura del modal de confirmación");
  await page.getByText(/Confirma la Operaci[oó]n/i).waitFor({ state: "visible", timeout: 10000 });
  const finalConfirm = await assertUnique(page.getByRole("button", { name: /^Confirmar$/i }), "Confirmar del modal final");
  assertOfficialArcaRcelUrl(page.url(), "la confirmación fiscal final");
  await finalConfirm.click();
  await waitForPageSettled(page);
  assertOfficialArcaRcelUrl(page.url(), "la lectura del resultado de emisión");
  await page.getByText(/Comprobante Generado/i).waitFor({ state: "visible", timeout: 60000 });
  await waitForPageSettled(page);
  assertOfficialArcaRcelUrl(page.url(), "la extracción del resultado de emisión");
  const bodyText = await page.locator("body").innerText({ timeout: 3000 });
  return {
    voucherNumber: extract(bodyText, /(?:Comprobante|N[uú]mero)\s*(?:Nro\.?|N[°º])?\s*:?\s*([0-9-]{6,})/i),
    cae: extract(bodyText, /CAE\s*:?\s*([0-9]{8,})/i),
    bodyText,
  };
}

export async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function assertUnique(locator: ReturnType<Page["locator"]>, description: string): Promise<ReturnType<Page["locator"]>> {
  assertOfficialArcaRcelUrl(locator.page().url(), `la lectura de ${description}`);
  const visible = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
  }
  if (visible.length !== 1) throw new Error(`${description}: se esperaba un único control visible y se encontraron ${visible.length}.`);
  return visible[0] as ReturnType<Page["locator"]>;
}

function extract(value: string, pattern: RegExp): string | undefined {
  return value.match(pattern)?.[1];
}
