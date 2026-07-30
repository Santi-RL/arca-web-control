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
  const recipientName = await optionalInput(page.locator("#razonsocialreceptor"));
  if (!recipientName) throw new Error("ARCA no completó la razón social del receptor.");
  if (job.recipientName && !sameText(recipientName, job.recipientName)) {
    throw new Error(`La razón social devuelta por ARCA no coincide con el job: ${recipientName}.`);
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
  return compact({ recipientName, recipientCommercialAddress: address, recipientVatCondition: vat });
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
