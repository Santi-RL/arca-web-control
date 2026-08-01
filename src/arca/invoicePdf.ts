import fs from "node:fs/promises";
import type { Download, Locator, Page } from "playwright";
import type { PdfDestinationReservation } from "../config/privateDownloads.js";
import { publishReservedPdf } from "../config/privateDownloads.js";
import type { ResolvedInvoiceJob } from "../types.js";
import { assertOfficialArcaGeneratedInvoicePageUrl } from "./officialUrls.js";

type CommonArcaInvoicePdfExpectation = {
  voucherType: string;
  pointOfSale: string;
  issueDate: string;
  billingPeriodFrom: string;
  billingPeriodTo: string;
  dueDate: string;
  saleCondition: string;
  issuerCuit: string;
  description: string;
  amountCents: number;
};

export type ArcaInvoicePdfExpectation = CommonArcaInvoicePdfExpectation & (
  | { recipientKind?: "identified-cuit"; recipientCuit: string }
  | { recipientKind: "anonymous-final-consumer"; recipientCuit?: never }
);

export type ArcaInvoicePdfEvidence = {
  voucherNumber: string;
  cae: string;
  pageCount: number;
};

export function assertArcaInvoicePdfMatchesKnownReceipt(
  evidence: Pick<ArcaInvoicePdfEvidence, "voucherNumber" | "cae">,
  known: { voucherNumber?: string; cae?: string } | undefined,
): void {
  if (known?.voucherNumber && known.voucherNumber !== evidence.voucherNumber) {
    throw new Error("El número extraído del PDF no coincide con el número ya conservado en el ledger unknown.");
  }
  if (known?.cae && known.cae !== evidence.cae) {
    throw new Error("El CAE extraído del PDF no coincide con el CAE ya conservado en el ledger unknown.");
  }
}

export function buildArcaInvoicePdfExpectation(job: ResolvedInvoiceJob): ArcaInvoicePdfExpectation {
  const common = {
    voucherType: job.voucherType,
    pointOfSale: job.pointOfSale,
    issueDate: formatDate(job.date),
    billingPeriodFrom: formatDate(requiredPdfJobField(job.billingPeriodFrom, "inicio del período facturado")),
    billingPeriodTo: formatDate(requiredPdfJobField(job.billingPeriodTo, "fin del período facturado")),
    dueDate: formatDate(requiredPdfJobField(job.dueDate, "vencimiento")),
    saleCondition: requiredPdfJobField(job.saleCondition, "condición de venta"),
    issuerCuit: job.issuerKey,
    description: job.description,
    amountCents: job.amountCents,
  };
  if (job.recipientKind === "anonymous-final-consumer") {
    return { ...common, recipientKind: "anonymous-final-consumer" };
  }
  return { ...common, recipientCuit: job.recipientCuit };
}

type GeneratedInvoiceDownload = Pick<Download, "failure" | "saveAs" | "cancel">;

export async function downloadGeneratedInvoicePdf(
  page: Page,
  reservation: PdfDestinationReservation,
  timeoutMs = 30_000,
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("El timeout de descarga PDF es inválido.");
  assertOfficialArcaGeneratedInvoicePageUrl(page.url());
  const controls = page.getByRole("button", { name: /^Imprimir(?:\.{3}|…)?$/i })
    .or(page.getByRole("link", { name: /^Imprimir(?:\.{3}|…)?$/i }));
  const visible = await visibleLocators(controls);
  if (visible.length !== 1) throw new Error(`Imprimir: se esperaba un único control visible y se encontraron ${visible.length}. No se abrió ninguna URL alternativa.`);

  const deadline = Date.now() + timeoutMs;
  let download: Download;
  try {
    assertOfficialArcaGeneratedInvoicePageUrl(page.url());
    [download] = await beforeDeadline(Promise.all([
      page.waitForEvent("download", { timeout: remainingMilliseconds(deadline) }),
      visible[0]!.click({ timeout: remainingMilliseconds(deadline) }),
    ]), deadline);
  } catch {
    throw new Error("ARCA accionó Imprimir, pero no se pudo capturar la descarga. No se reintentó el clic.");
  }
  return await persistGeneratedInvoiceDownload(download, reservation, deadline);
}

export async function persistGeneratedInvoiceDownload(
  download: GeneratedInvoiceDownload,
  reservation: PdfDestinationReservation,
  deadline: number,
): Promise<string> {
  try {
    const failure = await beforeDeadline(download.failure(), deadline);
    if (failure) throw new Error("ARCA inició la descarga del comprobante, pero el navegador informó una falla.");
    await beforeDeadline(download.saveAs(reservation.temporaryPath), deadline);
  } catch (error) {
    if (error instanceof DownloadDeadlineError) {
      reservation.preserveTemporary();
      void download.cancel().catch(() => undefined);
      throw new Error("La descarga del comprobante no terminó dentro del plazo seguro. No se reintentó el clic y cualquier resultado debe reconciliarse.");
    }
    throw error;
  }
  await assertPdfSignature(reservation.temporaryPath);
  return await publishReservedPdf(reservation);
}

class DownloadDeadlineError extends Error {}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const timeoutMs = remainingMilliseconds(deadline);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DownloadDeadlineError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remainingMilliseconds(deadline: number): number {
  if (!Number.isFinite(deadline)) throw new Error("El plazo de descarga PDF es inválido.");
  const remaining = Math.ceil(deadline - Date.now());
  if (remaining <= 0) throw new DownloadDeadlineError();
  return remaining;
}

export async function inspectArcaInvoicePdf(
  pdfPath: string,
  expected: ArcaInvoicePdfExpectation,
): Promise<ArcaInvoicePdfEvidence> {
  const bytes = await fs.readFile(pdfPath);
  assertPdfBytes(bytes);

  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    verbosity: 0,
  });
  try {
    const document = await loadingTask.promise;
    if (document.numPages < 1) throw new Error("El PDF descargado no contiene páginas.");
    const pageReceipts: Array<{ voucherNumber: string; cae: string }> = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
      const receipt = assertExpectedInvoiceText(text, expected, buildVisualTextLines(content.items));
      pageReceipts.push({
        voucherNumber: `${receipt.voucherReference.pointOfSale}-${receipt.voucherReference.number}`,
        cae: receipt.cae,
      });
    }
    const firstReceipt = pageReceipts[0]!;
    if (pageReceipts.some((receipt) => receipt.voucherNumber !== firstReceipt.voucherNumber || receipt.cae !== firstReceipt.cae)) {
      throw new Error("Las páginas del PDF de ARCA no coinciden en número de comprobante y CAE.");
    }

    return {
      voucherNumber: firstReceipt.voucherNumber,
      cae: firstReceipt.cae,
      pageCount: document.numPages,
    };
  } finally {
    await loadingTask.destroy();
  }
}

async function assertPdfSignature(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    const bytes = Buffer.alloc(5);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== 5) throw new Error("La descarga de ARCA no tiene una firma PDF válida.");
    assertPdfBytes(bytes);
  } finally {
    await handle.close();
  }
}

function assertPdfBytes(bytes: Uint8Array): void {
  if (bytes.length < 5 || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") {
    throw new Error("La descarga de ARCA no tiene una firma PDF válida.");
  }
}

function assertExpectedInvoiceText(
  text: string,
  expected: ArcaInvoicePdfExpectation,
  visualLines: readonly string[],
): { voucherReference: { pointOfSale: string; number: string }; cae: string } {
  const normalizedText = normalizeText(text);
  const expectedSignals = [
    ["comprobante autorizado", "estado autorizado"],
  ] as const;
  for (const [signal, label] of expectedSignals) {
    if (!normalizedText.includes(signal)) throw new Error(`El PDF de ARCA no coincide con el ${label} esperado.`);
  }

  assertExpectedVoucherType(normalizedText, expected.voucherType);
  assertExpectedFiscalRows(visualLines, expected);
  assertExpectedInvoiceCuitsPdf(visualLines, expected);
  if (expected.recipientKind === "anonymous-final-consumer") {
    assertAnonymousFinalConsumerPdf(visualLines);
  }

  const voucherReference = extractVoucherReference(text);
  if (voucherReference.pointOfSale !== expected.pointOfSale.padStart(5, "0")) {
    throw new Error("El PDF de ARCA no coincide con el punto de venta esperado.");
  }
  const visualTotalLines = visualLines.filter((line) => /Importe\s+Total/iu.test(line));
  const totalLabelOccurrences = visualTotalLines
    .reduce((count, line) => count + (line.match(/Importe\s+Total/giu)?.length ?? 0), 0);
  const visualTotal = visualTotalLines[0] ? extractVisualTotal(visualTotalLines[0]) : undefined;
  if (visualTotalLines.length !== 1
    || totalLabelOccurrences !== 1
    || visualTotal !== expected.amountCents) {
    throw new Error("El PDF de ARCA no coincide con el Importe Total esperado.");
  }

  assertExpectedSingleItemRow(visualLines, expected.description, expected.amountCents);
  return { voucherReference, cae: extractCae(visualLines) };
}

function assertExpectedFiscalRows(
  visualLines: readonly string[],
  expected: Pick<ArcaInvoicePdfExpectation, "issueDate" | "billingPeriodFrom" | "billingPeriodTo" | "dueDate" | "saleCondition">,
): void {
  const issueDateLine = uniqueVisualLineWithLabels(visualLines, { issueDate: PDF_ISSUE_DATE_LABEL }, "fecha de emisión");
  assertDateImmediatelyAfterLabel(issueDateLine, PDF_ISSUE_DATE_LABEL, expected.issueDate, "fecha de emisión");

  const periodLine = uniqueVisualLineWithLabels(visualLines, {
    from: PDF_BILLING_PERIOD_FROM_LABEL,
    to: PDF_BILLING_PERIOD_TO_LABEL,
  }, "período facturado");
  assertDateImmediatelyAfterLabel(periodLine, PDF_BILLING_PERIOD_FROM_LABEL, expected.billingPeriodFrom, "inicio del período facturado");
  assertDateImmediatelyAfterLabel(periodLine, PDF_BILLING_PERIOD_TO_LABEL, expected.billingPeriodTo, "fin del período facturado");

  const dueDateLine = uniqueVisualLineWithLabels(visualLines, { dueDate: PDF_DUE_DATE_LABEL }, "vencimiento");
  assertDateImmediatelyAfterLabel(dueDateLine, PDF_DUE_DATE_LABEL, expected.dueDate, "vencimiento");

  const saleConditionLine = uniqueVisualLineWithLabels(visualLines, { saleCondition: PDF_SALE_CONDITION_LABEL }, "condición de venta");
  const { saleCondition } = extractVisualLabeledValues(saleConditionLine, { saleCondition: PDF_SALE_CONDITION_LABEL });
  if (!saleConditionMatchesPdf(saleCondition, expected.saleCondition)) {
    throw new Error("El PDF de ARCA no coincide con la condición de venta esperada.");
  }
}

function assertExpectedSingleItemRow(visualLines: readonly string[], expectedDescription: string, expectedAmountCents: number): void {
  const normalizedDescription = normalizeText(expectedDescription);
  if (!normalizedDescription) throw new Error("La descripción esperada para validar el PDF es inválida.");
  const candidates = visualLines.filter((line) => countOccurrences(normalizeText(line), normalizedDescription) === 1);
  if (candidates.length !== 1) {
    throw new Error("El PDF de ARCA no contiene una única fila visual para el ítem esperado.");
  }

  const normalizedRow = normalizeText(candidates[0]!);
  const quantityCandidates = [...normalizedRow.matchAll(PDF_ITEM_QUANTITY_PATTERN)]
    .map((match) => {
      const quantity = match[1];
      const quantityIndex = match.index === undefined || !quantity ? undefined : match.index + match[0].length - quantity.length;
      const afterQuantity = quantityIndex === undefined ? "" : normalizedRow.slice(quantityIndex + quantity!.length);
      return { quantity, quantityIndex, afterQuantity, monies: [...afterQuantity.matchAll(PDF_ITEM_MONEY_PATTERN)] };
    })
    .filter((candidate) => candidate.quantityIndex !== undefined && candidate.monies.length >= 2);
  if (quantityCandidates.length !== 1) {
    throw new Error("El PDF de ARCA no confirma cantidad 1 en la fila del único ítem esperado.");
  }
  const quantity = quantityCandidates[0]!;
  const actualDescription = normalizedRow.slice(0, quantity.quantityIndex).trim();
  if (actualDescription !== normalizedDescription) {
    throw new Error("El PDF de ARCA no coincide exactamente con la descripción de la fila del único ítem.");
  }

  const monies = quantity.monies
    .map((match) => ({ value: match[0], cents: parsePdfMoney(match[0]) }));
  if (monies.length < 2 || monies[0]?.cents !== expectedAmountCents) {
    throw new Error("El PDF de ARCA no confirma el precio unitario esperado en la fila del único ítem.");
  }
  if (monies.at(-1)?.cents !== expectedAmountCents) {
    throw new Error("El PDF de ARCA no confirma el subtotal esperado en la fila del único ítem.");
  }
}

function assertAnonymousFinalConsumerPdf(visualLines: readonly string[]): void {
  const indexedLines = visualLines.map((line, index) => ({ line, index }));
  const identityCandidates = indexedLines
    .filter(({ line }) => countPattern(line, PDF_RECIPIENT_NAME_LABEL) === 1);
  const vatAddressCandidates = indexedLines
    .filter(({ line }) => countPattern(line, PDF_VAT_LABEL) === 1 && countPattern(line, PDF_ADDRESS_LABEL) === 1);
  const recipientLabelsAreUnique = [PDF_RECIPIENT_NAME_LABEL, PDF_ADDRESS_LABEL]
    .every((label) => visualLines.reduce((count, line) => count + countPattern(line, label), 0) === 1);
  if (!recipientLabelsAreUnique || identityCandidates.length !== 1 || vatAddressCandidates.length !== 1) {
    throw new Error("El PDF de ARCA no contiene un bloque único y completo de receptor anónimo.");
  }
  const identity = identityCandidates[0]!;
  const vatAddress = vatAddressCandidates[0]!;
  if (vatAddress.index !== identity.index + 1) {
    throw new Error("El PDF de ARCA no conserva juntas las filas visuales de identidad del receptor.");
  }
  const recipientCuitLabelCount = countPattern(identity.line, PDF_CUIT_LABEL);
  if (recipientCuitLabelCount > 1) {
    throw new Error("El PDF de ARCA contiene un CUIT ambiguo para un receptor que debía ser anónimo.");
  }
  const identityFirstLabelIndex = Math.min(
    identity.line.search(PDF_RECIPIENT_NAME_LABEL),
    ...(recipientCuitLabelCount === 1 ? [identity.line.search(PDF_CUIT_LABEL)] : []),
  );
  const vatAddressFirstLabelIndex = Math.min(
    vatAddress.line.search(PDF_VAT_LABEL),
    vatAddress.line.search(PDF_ADDRESS_LABEL),
  );
  const identityPrefix = identity.line.slice(0, identityFirstLabelIndex).trim();
  const identityPrefixIsAllowed = recipientCuitLabelCount === 0
    ? /^Doc\s*\.\s*:\s*-$/u.test(identityPrefix)
    : identityPrefix === "";
  if (!identityPrefixIsAllowed || vatAddress.line.slice(0, vatAddressFirstLabelIndex).trim()) {
    throw new Error("El PDF de ARCA contiene texto inesperado antes de las etiquetas del receptor anónimo.");
  }
  const identityValues = recipientCuitLabelCount === 1
    ? extractVisualLabeledValues(identity.line, { cuit: PDF_CUIT_LABEL, name: PDF_RECIPIENT_NAME_LABEL })
    : { cuit: "", ...extractVisualLabeledValues(identity.line, { name: PDF_RECIPIENT_NAME_LABEL }) };
  const vatAddressValues = extractVisualLabeledValues(vatAddress.line, {
    vat: PDF_VAT_LABEL,
    address: PDF_ADDRESS_LABEL,
  });
  if (identityValues.cuit !== "" || identityValues.name !== "" || vatAddressValues.address !== "") {
    throw new Error("El PDF de ARCA contiene CUIT, nombre o domicilio para un receptor que debía ser anónimo.");
  }
  if (normalizeText(vatAddressValues.vat) !== "consumidor final") {
    throw new Error("El PDF de ARCA no confirma al receptor como Consumidor Final sin identificar.");
  }
}

const PDF_CUIT_LABEL = /\bCUIT\s*:\s*/iu;
const PDF_CAE_RECEIPT_LABEL = /^CAE\s+N[°º]\s*:\s*/iu;
const PDF_ISSUE_DATE_LABEL = /Fecha\s+de\s+Emisi[oó]n\s*:\s*/iu;
const PDF_RECIPIENT_NAME_LABEL = /Apellido\s+y\s+Nombre\s*\/\s*Raz[oó]n\s+Social\s*:\s*/iu;
const PDF_VAT_LABEL = /Condici[oó]n\s+frente\s+al\s+IVA\s*:\s*/iu;
const PDF_ADDRESS_LABEL = /\bDomicilio\s*:\s*/iu;
const PDF_BILLING_PERIOD_FROM_LABEL = /Per[ií]odo\s+Facturado\s+Desde\s*:\s*/iu;
const PDF_BILLING_PERIOD_TO_LABEL = /\bHasta\s*:\s*/iu;
const PDF_DUE_DATE_LABEL = /(?:Fecha\s+de\s+Vto\.?\s+para\s+el\s+pago|Fecha\s+de\s+Vencimiento)\s*:\s*/iu;
const PDF_SALE_CONDITION_LABEL = /Condici[oó]n\s+de\s+venta\s*:\s*/iu;

const PDF_ITEM_MONEY_PATTERN = /(?<!\d)(?:\d{1,3}(?:\.\d{3})+,\s*\d{2}|\d{1,3}(?:,\d{3})+\.\s*\d{2}|\d{1,3}(?:[ \u00a0]\d{3})+[,.]\s*\d{2}|\d+[,.]\s*\d{2})(?!\d)/gu;
const PDF_ITEM_QUANTITY_PATTERN = /(?:^|\s)(1(?:[.,]0{1,4})?)(?=\s|$)/gu;

function assertExpectedInvoiceCuitsPdf(visualLines: readonly string[], expected: ArcaInvoicePdfExpectation): void {
  const indexedLines = visualLines.map((line, index) => ({ line, index }));
  if (indexedLines.some(({ line }) => countPattern(line, PDF_CUIT_LABEL) > 1)) {
    throw new Error("El PDF de ARCA contiene más de una etiqueta CUIT en una misma fila.");
  }
  const cuitLines = indexedLines.filter(({ line }) => countPattern(line, PDF_CUIT_LABEL) === 1);
  const issuerCuit = expectedCuitDigits(expected.issuerCuit);
  const issuerLines = cuitLines.filter(({ line }) => countPattern(line, PDF_RECIPIENT_NAME_LABEL) === 0
    && immediateLabeledCuitDigits(line) === issuerCuit);
  if (issuerLines.length !== 1) {
    throw new Error("El PDF de ARCA no contiene un único CUIT etiquetado e inmediato para el emisor esperado.");
  }

  if (expected.recipientKind === "anonymous-final-consumer") {
    const recipientCuitLines = cuitLines.filter(({ line }) => countPattern(line, PDF_RECIPIENT_NAME_LABEL) === 1);
    if (cuitLines.length < 1 || cuitLines.length > 2 || recipientCuitLines.length !== cuitLines.length - 1) {
      throw new Error("El PDF de ARCA contiene etiquetas CUIT adicionales o ambiguas para el receptor anónimo.");
    }
    if (recipientCuitLines[0]) {
      const values = extractVisualLabeledValues(recipientCuitLines[0].line, {
        cuit: PDF_CUIT_LABEL,
        name: PDF_RECIPIENT_NAME_LABEL,
      });
      if (values.cuit !== "") {
        throw new Error("El PDF de ARCA contiene un CUIT para un receptor que debía ser anónimo.");
      }
    }
    return;
  }

  const recipientCuit = expectedCuitDigits(expected.recipientCuit);
  const recipientLines = cuitLines.filter(({ line }) => countPattern(line, PDF_RECIPIENT_NAME_LABEL) === 1
    && immediateLabeledCuitDigits(line) === recipientCuit);
  if (cuitLines.length !== 2 || recipientLines.length !== 1 || recipientLines[0]!.index === issuerLines[0]!.index) {
    throw new Error("El PDF de ARCA no contiene un único CUIT etiquetado e inmediato para el receptor esperado.");
  }
}

function immediateLabeledCuitDigits(line: string): string | undefined {
  const label = PDF_CUIT_LABEL.exec(line);
  if (!label?.[0] || label.index === undefined) return undefined;
  const match = /^(\d{2})(?:-|\s)?(\d{8})(?:-|\s)?(\d)(?=\s|$)/u.exec(line.slice(label.index + label[0].length));
  return match ? `${match[1]}${match[2]}${match[3]}` : undefined;
}

function expectedCuitDigits(value: string): string {
  const digits = value.replace(/\D/gu, "");
  if (!/^\d{11}$/u.test(digits)) throw new Error("El CUIT esperado para validar el PDF es inválido.");
  return digits;
}

function extractVisualLabeledValues<K extends string>(
  line: string,
  labels: Record<K, RegExp>,
): Record<K, string> {
  const matches = Object.entries(labels).map(([key, pattern]) => {
    const expression = pattern as RegExp;
    const match = expression.exec(line);
    if (!match || match.index === undefined || countPattern(line, expression) !== 1) {
      throw new Error("El PDF de ARCA contiene etiquetas fiscales ausentes o ambiguas.");
    }
    return { key: key as K, index: match.index, end: match.index + match[0].length };
  }).sort((left, right) => left.index - right.index);
  const result = {} as Record<K, string>;
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index]!;
    result[current.key] = line.slice(current.end, matches[index + 1]?.index ?? line.length).trim();
  }
  return result;
}

function uniqueVisualLineWithLabels<K extends string>(
  visualLines: readonly string[],
  labels: Record<K, RegExp>,
  fieldLabel: string,
): string {
  const expressions = Object.values(labels) as RegExp[];
  const candidates = visualLines.filter((line) => expressions.every((expression) => countPattern(line, expression) === 1));
  const everyLabelIsUnique = expressions.every((expression) => visualLines
    .reduce((count, line) => count + countPattern(line, expression), 0) === 1);
  if (!everyLabelIsUnique || candidates.length !== 1 || !candidates[0]) {
    throw new Error(`El PDF de ARCA no contiene una única fila etiquetada de ${fieldLabel}.`);
  }
  return candidates[0];
}

function assertDateImmediatelyAfterLabel(line: string, label: RegExp, expected: string, fieldLabel: string): void {
  const match = label.exec(line);
  if (!match?.[0] || match.index === undefined) {
    throw new Error(`El PDF de ARCA no contiene una única fila etiquetada de ${fieldLabel}.`);
  }
  const actual = /^(\d{2}\/\d{2}\/\d{4})(?=\s|$)/u.exec(line.slice(match.index + match[0].length))?.[1];
  if (actual !== expected) {
    throw new Error(`El PDF de ARCA no coincide con el valor esperado para ${fieldLabel}.`);
  }
}

function saleConditionMatchesPdf(actual: string, expected: string): boolean {
  const normalizedActual = normalizeText(actual);
  const normalizedExpected = normalizeText(expected);
  if (/^otr[oa]$/u.test(normalizedExpected)) return /^otr[oa]$/u.test(normalizedActual);
  return normalizedActual === normalizedExpected;
}

function countOccurrences(value: string, expected: string): number {
  if (!expected) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(expected, offset)) >= 0) {
    count += 1;
    offset += expected.length;
  }
  return count;
}

function countPattern(value: string, pattern: RegExp): number {
  const flags = [...new Set(`${pattern.flags}g`.split(""))].join("");
  return [...value.matchAll(new RegExp(pattern.source, flags))].length;
}

function extractVisualTotal(line: string): number | undefined {
  const label = /\bImporte\s+Total\b\s*:?/iu.exec(line);
  if (!label?.[0] || label.index === undefined || line.slice(0, label.index).trim().length > 0) return undefined;
  const afterLabel = line.slice(label.index + label[0].length);
  const amount = PDF_TOTAL_VALUE_PATTERN.exec(afterLabel)?.[1];
  return amount ? parsePdfMoney(amount) : undefined;
}

const PDF_TOTAL_VALUE_PATTERN = /^\s*(?:\$|ARS)?\s*((?:\d{1,3}(?:\.\d{3})+,\s*\d{2}|\d{1,3}(?:,\d{3})+\.\s*\d{2}|\d{1,3}(?:[ \u00a0]\d{3})+[,.]\s*\d{2}|\d+[,.]\s*\d{2}))\s*$/iu;

function buildVisualTextLines(items: readonly unknown[]): string[] {
  const positioned = items
    .filter(isPositionedTextItem)
    .map((item, index) => ({
      str: item.str.trim(),
      x: item.transform[4] as number,
      y: item.transform[5] as number,
      height: item.height,
      index,
    }))
    .filter((item) => item.str.length > 0);
  const lines: Array<{ y: number; height: number; items: Array<{ str: string; x: number; index: number }> }> = [];
  for (const item of positioned) {
    const line = lines.find((candidate) => {
      const tolerance = Math.max(0.5, Math.min(2, Math.min(candidate.height, item.height) * 0.25));
      return Math.abs(candidate.y - item.y) <= tolerance;
    });
    if (line) line.items.push({ str: item.str, x: item.x, index: item.index });
    else lines.push({ y: item.y, height: item.height, items: [{ str: item.str, x: item.x, index: item.index }] });
  }
  return lines.sort((left, right) => right.y - left.y).map((line) => line.items
    .sort((left, right) => left.x - right.x || left.index - right.index)
    .map((item) => item.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim());
}

function isPositionedTextItem(value: unknown): value is { str: string; transform: number[]; height: number } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { str?: unknown; transform?: unknown; height?: unknown };
  return typeof candidate.str === "string"
    && Array.isArray(candidate.transform)
    && candidate.transform.length >= 6
    && Number.isFinite(candidate.transform[4])
    && Number.isFinite(candidate.transform[5])
    && typeof candidate.height === "number"
    && Number.isFinite(candidate.height)
    && candidate.height > 0;
}

function extractVoucherReference(text: string): { pointOfSale: string; number: string } {
  const patterns = [
    /Punto\s+de\s+Venta\s*:\s*(\d{1,5})\s+Comp\.?\s*Nro\.?\s*:\s*(\d{6,8})/giu,
    /Punto\s+de\s+Venta\s*:\s*Comp\.?\s*Nro\.?\s*:?\s*(\d{1,5})\s+(\d{6,8})/giu,
  ];
  const references: Array<{ pointOfSale: string; number: string }> = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const pointOfSale = match[1];
      const number = match[2];
      if (pointOfSale && number) references.push({ pointOfSale: pointOfSale.padStart(5, "0"), number: number.padStart(8, "0") });
    }
  }
  if (references.length !== 1 || !references[0]) {
    throw new Error("No se pudo extraer un único punto de venta y número etiquetados del PDF de ARCA.");
  }
  return references[0];
}

function extractCae(visualLines: readonly string[]): string {
  const candidates = visualLines.filter((line) => PDF_CAE_RECEIPT_LABEL.test(line));
  if (candidates.length !== 1 || !candidates[0]) {
    throw new Error("No se pudo extraer una única ocurrencia etiquetada de CAE en las filas visuales del PDF de ARCA.");
  }
  const label = PDF_CAE_RECEIPT_LABEL.exec(candidates[0]);
  const value = label?.[0] ? candidates[0].slice(label[0].length) : "";
  if (!/^\d{14}$/u.test(value)) {
    throw new Error("La fila visual etiquetada de CAE no contiene un único valor inmediato de 14 dígitos.");
  }
  return value;
}

function assertExpectedVoucherType(normalizedText: string, expectedVoucherType: string): void {
  const expected = /^factura\s+([abc])$/u.exec(normalizeText(expectedVoucherType));
  if (!expected?.[1] || !normalizedText.includes("factura")) {
    throw new Error("El PDF de ARCA no coincide con el tipo de comprobante esperado.");
  }
  const letter = expected[1];
  const codeByLetter: Record<string, string> = { a: "001", b: "006", c: "011" };
  const contiguous = new RegExp(`(?:^|\\s)factura\\s+${letter}(?:\\s|$)`, "u").test(normalizedText);
  const separated = new RegExp(`(?:^|\\s)${letter}\\s*(?:/|\\s)+cod\\.?\\s*0*${Number(codeByLetter[letter])}(?:\\s|/|$)`, "u").test(normalizedText);
  if (!contiguous && !separated) {
    throw new Error("El PDF de ARCA no coincide con la letra y el código del comprobante esperado.");
  }
}

function parsePdfMoney(value: string): number | undefined {
  const compact = value.replace(/\s/g, "");
  const separator = Math.max(compact.lastIndexOf("."), compact.lastIndexOf(","));
  if (separator < 0 || compact.length - separator - 1 !== 2) return undefined;
  const whole = compact.slice(0, separator).replace(/\D/g, "") || "0";
  const fraction = compact.slice(separator + 1).replace(/\D/g, "");
  const cents = Number(whole) * 100 + Number(fraction);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function formatDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function requiredPdfJobField(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`El job no contiene ${label} para validar el PDF fiscal.`);
  return value;
}

async function visibleLocators(locator: Locator): Promise<Locator[]> {
  const result: Locator[] = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const current = locator.nth(index);
    if (await current.isVisible().catch(() => false)) result.push(current);
  }
  return result;
}
