import { Locator, Page } from "playwright";
import { assertOfficialArcaRcelUrl } from "./officialUrls.js";

export const recipientCommercialAddressSelect = "#domicilioreceptor, #domicilioreceptorcombo, select[name='domicilioReceptor' i], select[name='domicilioReceptorCombo' i]";
export const recipientCommercialAddressInput = "input[name*='domicilio' i], input[id*='domicilio' i]";

export type CommercialAddressMatch = "exact" | "caba-equivalent" | "none";

export type RecipientCommercialAddressEvidence = {
  value: string;
  source: "select" | "custom-input" | "input";
  selectedOption?: string;
};

/**
 * Normalización estricta: ignora mayúsculas, tildes, puntuación y espacios,
 * pero no acepta coincidencias parciales ni elimina componentes del domicilio.
 */
export function normalizeCommercialAddress(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Única equivalencia adicional documentada: ARCA puede expresar CABA como
 * "CABA", "Capital Federal", "Ciudad de Buenos Aires" o
 * "Ciudad Autónoma de Buenos Aires". El resto del domicilio debe coincidir.
 */
export function classifyCommercialAddressMatch(actual: string, expected: string): CommercialAddressMatch {
  const normalizedActual = normalizeCommercialAddress(actual);
  const normalizedExpected = normalizeCommercialAddress(expected);
  if (normalizedActual === normalizedExpected) return "exact";
  if (canonicalizeCaba(normalizedActual) === canonicalizeCaba(normalizedExpected)) return "caba-equivalent";
  return "none";
}

export function commercialAddressesMatch(actual: string, expected: string): boolean {
  return classifyCommercialAddressMatch(actual, expected) !== "none";
}

export function isOtherCommercialAddressOption(value: string): boolean {
  return /^otr[oa](?:\.*)?$/i.test(value.trim());
}

export function isCommercialAddressPlaceholder(text: string, value?: string | null): boolean {
  const sentinel = value === undefined || value === null || value === "" || value === "-1";
  return sentinel && /^seleccionar(?:\.*)?$/i.test(text.trim());
}

export async function readRecipientCommercialAddress(page: Page): Promise<RecipientCommercialAddressEvidence> {
  assertOfficialArcaRcelUrl(page.url(), "la lectura del domicilio comercial del receptor");
  const selects = await visibleLocators(page.locator(recipientCommercialAddressSelect));
  if (selects.length > 1) {
    throw new Error(`Domicilio comercial: se esperaba un único selector visible y se encontraron ${selects.length}.`);
  }

  const select = selects[0];
  if (select) {
    const selectedOptions = select.locator("option:checked");
    if (await selectedOptions.count() !== 1) {
      throw new Error("Domicilio comercial: ARCA no mostró una única opción seleccionada.");
    }
    const selected = selectedOptions.first();
    const text = ((await selected.textContent()) ?? "").trim();
    const value = await selected.getAttribute("value");
    if (!text || isCommercialAddressPlaceholder(text, value)) {
      throw new Error("Domicilio comercial: ARCA mantuvo la opción sin seleccionar.");
    }

    if (isOtherCommercialAddressOption(text)) {
      const custom = await uniqueVisibleAddressInput(page, "domicilio comercial personalizado");
      const customValue = (await custom.inputValue()).trim();
      if (!customValue) throw new Error("Domicilio comercial: la opción Otro/Otra no tiene un domicilio personalizado visible.");
      return { value: customValue, source: "custom-input", selectedOption: text };
    }

    return { value: text, source: "select", selectedOption: text };
  }

  const input = await uniqueVisibleAddressInput(page, "domicilio comercial");
  const value = (await input.inputValue()).trim();
  if (!value) throw new Error("ARCA no mostró un domicilio comercial verificable para el receptor.");
  return { value, source: "input" };
}

export async function uniqueVisibleAddressInput(page: Page, description: string): Promise<Locator> {
  assertOfficialArcaRcelUrl(page.url(), `la lectura de ${description}`);
  const inputs = await visibleLocators(page.locator(recipientCommercialAddressInput));
  if (inputs.length !== 1) {
    throw new Error(`${description}: se esperaba un único campo visible y se encontraron ${inputs.length}.`);
  }
  return inputs[0] as Locator;
}

export async function waitForUniqueVisibleAddressInput(page: Page, description: string, timeoutMs = 5000): Promise<Locator> {
  assertOfficialArcaRcelUrl(page.url(), `la espera de ${description}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inputs = await visibleLocators(page.locator(recipientCommercialAddressInput));
    if (inputs.length === 1) return inputs[0] as Locator;
    if (inputs.length > 1) {
      throw new Error(`${description}: se esperaba un único campo visible y se encontraron ${inputs.length}.`);
    }
    await page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`${description}: ARCA no mostró el campo único dentro del plazo seguro.`);
}

async function visibleLocators(locator: Locator): Promise<Locator[]> {
  const visible: Locator[] = [];
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const current = locator.nth(index);
    if (await current.isVisible().catch(() => false)) visible.push(current);
  }
  return visible;
}

function canonicalizeCaba(value: string): string {
  const withAliases = value
    .replace(/\bciudad autonoma de buenos aires\b/g, "caba")
    .replace(/\bcapital federal\b/g, "caba")
    .replace(/\bciudad de buenos aires\b/g, "caba");
  const tokens = withAliases.split(" ").filter(Boolean);
  return tokens.filter((token, index) => token !== "caba" || tokens[index - 1] !== "caba").join(" ");
}
