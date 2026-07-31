import { Locator, Page } from "playwright";
import { ResolvedInvoiceJob } from "../types.js";
import { formatDateForArca } from "../utils/date.js";
import { assertOfficialArcaRcelUrl } from "./officialUrls.js";
import { commercialAddressesMatch, readRecipientCommercialAddress } from "./recipientCommercialAddress.js";
import { captureIssuerControlEvidence } from "./issuerEvidence.js";

export type InvoiceControlEvidence = {
  issuer?: string;
  issuerCuit?: string;
  issueDate?: string;
  currency?: "ARS";
  billingPeriodFrom?: string;
  billingPeriodTo?: string;
  dueDate?: string;
  recipientCuit?: string;
  recipientName?: string;
  recipientCommercialAddress?: string;
  recipientVatCondition?: string;
  description?: string;
  amount?: string;
  quantity?: string;
  unitPrice?: string;
  subtotal?: string;
  total?: string;
};

export async function captureIssuerEvidence(page: Page, job: ResolvedInvoiceJob): Promise<InvoiceControlEvidence> {
  return await captureIssuerControlEvidence(page, job.issuerKey);
}

export async function captureDateEvidence(page: Page, job: ResolvedInvoiceJob): Promise<InvoiceControlEvidence> {
  assertOfficialArcaRcelUrl(page.url(), "la captura de fecha, período y vencimiento");
  return compact({
    issueDate: await requiredInput(page.getByRole("textbox", { name: /Fecha del Comprobante/i }), "Fecha del Comprobante", formatDateForArca(job.date)),
    billingPeriodFrom: job.billingPeriodFrom ? await requiredInput(page.getByRole("textbox", { name: /^Desde$/i }), "Período desde", formatDateForArca(job.billingPeriodFrom)) : undefined,
    billingPeriodTo: job.billingPeriodTo ? await requiredInput(page.getByRole("textbox", { name: /^Hasta$/i }), "Período hasta", formatDateForArca(job.billingPeriodTo)) : undefined,
    dueDate: job.dueDate ? await requiredInput(page.getByRole("textbox", { name: /Vto\. para el Pago|Vencimiento/i }), "Vencimiento", formatDateForArca(job.dueDate)) : undefined,
  });
}

export async function captureCurrencyEvidence(page: Page, job: ResolvedInvoiceJob): Promise<InvoiceControlEvidence> {
  assertOfficialArcaRcelUrl(page.url(), "la captura de la moneda");
  if (job.currency !== "ARS") {
    throw new Error("La capacidad actual solo admite moneda local ARS.");
  }
  const foreignCurrency = await uniqueVisible(
    page.getByRole("checkbox", { name: /^Moneda Extranjera$/i }),
    "Moneda Extranjera",
  );
  if (await foreignCurrency.isChecked()) {
    throw new Error("ARCA muestra Moneda Extranjera marcada. La capacidad ARS fue bloqueada.");
  }
  return { currency: "ARS" };
}

export async function captureRecipientEvidence(page: Page, job: ResolvedInvoiceJob): Promise<InvoiceControlEvidence> {
  assertOfficialArcaRcelUrl(page.url(), "la captura de datos del receptor");
  const recipientCuitControl = await uniqueVisible(page.locator("#nrodocreceptor"), "CUIT del receptor");
  const recipientCuit = (await recipientCuitControl.inputValue()).trim();
  if (!/^[0-9]{11}$/u.test(recipientCuit) || !recipientCuitsMatch(recipientCuit, job.recipientCuit)) {
    throw new Error("El CUIT visible del receptor no coincide con el job.");
  }
  const recipientName = await optionalInput(page.locator("#razonsocialreceptor"));
  if (!recipientName) throw new Error("ARCA no completó la razón social del receptor.");
  if (job.recipientName && !recipientIdentityMatches(
    { cuit: recipientCuit, name: recipientName },
    { cuit: job.recipientCuit, name: job.recipientName },
  )) {
    throw new Error("La razón social devuelta por ARCA no coincide de forma segura con el job.");
  }
  const address = (await readRecipientCommercialAddress(page)).value;
  if (job.recipientCommercialAddress && !commercialAddressesMatch(address, job.recipientCommercialAddress)) {
    throw new Error(`El domicilio comercial visible no coincide con el job. Esperado: ${job.recipientCommercialAddress}; visible: ${address}.`);
  }
  const vat = await optionalSelectedText(page.locator("#idivareceptor"));
  if (!vat) throw new Error("ARCA no mostró una condición frente al IVA seleccionada para el receptor.");
  if (!sameText(vat, job.recipientVatCondition)) {
    throw new Error(`La condición IVA visible no coincide: ${vat}.`);
  }
  return compact({ recipientCuit, recipientName, recipientCommercialAddress: address, recipientVatCondition: vat });
}

const LEGAL_ENTITY_FORMS = new Set(["SA", "SAU", "SAS", "SRL", "SC", "SCA", "SCS", "SH", "UTE"]);

type RecipientIdentity = {
  cuit: string | undefined;
  name: string | undefined;
};

export function recipientCuitsMatch(actual: string | undefined, expected: string | undefined): boolean {
  const actualCuit = canonicalRecipientCuit(actual);
  const expectedCuit = canonicalRecipientCuit(expected);
  return Boolean(actualCuit && expectedCuit && actualCuit === expectedCuit);
}

/** La tolerancia nominal solo se habilita dentro de una identidad con CUIT exacto. */
export function recipientIdentityMatches(actual: RecipientIdentity, expected: RecipientIdentity): boolean {
  return recipientCuitsMatch(actual.cuit, expected.cuit) && recipientNamesMatch(actual.name, expected.name);
}

function recipientNamesMatch(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const left = parseRecipientName(actual);
  const right = parseRecipientName(expected);
  if (!left.valid || !right.valid || left.legalForm !== right.legalForm || left.tokens.length !== right.tokens.length) return false;

  let typoUsed = false;
  for (let index = 0; index < left.tokens.length; index += 1) {
    const leftToken = left.tokens[index] as string;
    const rightToken = right.tokens[index] as string;
    if (leftToken === rightToken) continue;
    if (typoUsed
      || Math.min(leftToken.length, rightToken.length) < 6
      || /^[0-9]+$/u.test(leftToken)
      || /^[0-9]+$/u.test(rightToken)
      || !isSingleCharacterTypo(leftToken, rightToken)) {
      return false;
    }
    typoUsed = true;
  }
  return left.tokens.length > 0;
}

function parseRecipientName(value: string): { tokens: string[]; legalForm?: string; valid: boolean } {
  const tokens = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/u)
    .filter(Boolean);

  const parsed = splitLegalEntityForm(tokens);
  if (!parsed.legalForm) return { ...parsed, valid: parsed.tokens.length > 0 };
  const nestedLegalForm = splitLegalEntityForm(parsed.tokens).legalForm;
  return { ...parsed, valid: parsed.tokens.length > 0 && !nestedLegalForm };
}

function splitLegalEntityForm(tokens: string[]): { tokens: string[]; legalForm?: string } {
  for (let length = Math.min(3, tokens.length); length >= 1; length -= 1) {
    const candidate = tokens.slice(-length).join("");
    if (LEGAL_ENTITY_FORMS.has(candidate)) return { tokens: tokens.slice(0, -length), legalForm: candidate };
  }
  return { tokens };
}

function canonicalRecipientCuit(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^[0-9]{11}$/u.test(trimmed)) return trimmed;
  if (/^[0-9]{2}-[0-9]{8}-[0-9]$/u.test(trimmed)) return trimmed.replace(/-/g, "");
  return undefined;
}

function isSingleCharacterTypo(left: string, right: string): boolean {
  const lengthDifference = left.length - right.length;
  if (Math.abs(lengthDifference) > 1) return false;
  if (lengthDifference === 0) {
    const differences: number[] = [];
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) differences.push(index);
      if (differences.length > 2) return false;
    }
    if (differences.length === 1) return true;
    if (differences.length !== 2) return false;
    const first = differences[0] as number;
    const second = differences[1] as number;
    return second === first + 1
      && left[first] === right[second]
      && left[second] === right[first];
  }

  const longer = lengthDifference > 0 ? left : right;
  const shorter = lengthDifference > 0 ? right : left;
  let longerIndex = 0;
  let shorterIndex = 0;
  let skipped = false;
  while (longerIndex < longer.length && shorterIndex < shorter.length) {
    if (longer[longerIndex] === shorter[shorterIndex]) {
      longerIndex += 1;
      shorterIndex += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    longerIndex += 1;
  }
  return true;
}

export async function captureDetailEvidence(page: Page, job: ResolvedInvoiceJob): Promise<InvoiceControlEvidence> {
  assertOfficialArcaRcelUrl(page.url(), "la captura del detalle de la operación");
  const description = await requiredInput(page.locator("#detalle_descripcion1"), "Descripción", job.description);
  const quantity = await requiredInput(page.locator("#detalle_cantidad1"), "Cantidad", "1");
  const unitPrice = await requiredInput(page.locator("#detalle_precio1"), "Precio unitario", job.amount.toFixed(2));
  return { description, quantity, unitPrice, amount: unitPrice };
}

async function requiredInput(locator: Locator, name: string, expected: string): Promise<string> {
  assertOfficialArcaRcelUrl(locator.page().url(), `la lectura de ${name}`);
  const control = await uniqueVisible(locator, name);
  const actual = (await control.inputValue()).trim();
  if (normalize(actual) !== normalize(expected)) throw new Error(`${name} no coincide. Esperado: ${expected}; visible: ${actual}.`);
  return actual;
}

async function optionalInput(locator: Locator): Promise<string | undefined> {
  assertOfficialArcaRcelUrl(locator.page().url(), "la lectura de un dato fiscal opcional");
  if (await locator.count() !== 1 || !await locator.isVisible().catch(() => false)) return undefined;
  return (await locator.inputValue().catch(() => "")).trim() || undefined;
}

async function optionalSelectedText(locator: Locator): Promise<string | undefined> {
  assertOfficialArcaRcelUrl(locator.page().url(), "la lectura de una selección fiscal");
  if (await locator.count() !== 1 || !await locator.isVisible().catch(() => false)) return undefined;
  return (await locator.locator("option:checked").textContent().catch(() => ""))?.trim() || undefined;
}

async function uniqueVisible(locator: Locator, name: string): Promise<Locator> {
  assertOfficialArcaRcelUrl(locator.page().url(), `la lectura de ${name}`);
  const visible: Locator[] = [];
  for (let index = 0; index < await locator.count(); index += 1) if (await locator.nth(index).isVisible().catch(() => false)) visible.push(locator.nth(index));
  if (visible.length !== 1) throw new Error(`${name}: se esperaba un único control visible y se encontraron ${visible.length}.`);
  return visible[0] as Locator;
}

function compact(value: InvoiceControlEvidence): InvoiceControlEvidence {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as InvoiceControlEvidence;
}
function normalize(value: string): string { return value.replace(/\s+/g, " ").replace(/,/g, ".").trim().toLowerCase(); }
function sameText(left: string, right: string): boolean { return normalize(left.normalize("NFD").replace(/[\u0300-\u036f]/g, "")) === normalize(right.normalize("NFD").replace(/[\u0300-\u036f]/g, "")); }
