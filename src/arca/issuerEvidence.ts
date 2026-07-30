import { Page } from "playwright";
import { isValidCuit } from "../jobs/schema.js";
import { assertOfficialArcaRcelUrl } from "./officialUrls.js";

export type IssuerControlEvidence = {
  issuer: string;
  issuerCuit: string;
};

export type IssuerSummaryBlockEvidence = {
  issuer: string;
  issuerCommercialAddress: string;
};

export type IssuerSummaryEvidence = IssuerSummaryBlockEvidence & {
  issuerCuit: string;
};

/** Captura la identidad del representado visible antes de iniciar la factura. */
export async function captureIssuerControlEvidence(page: Page, expectedIssuerCuit: string): Promise<IssuerControlEvidence> {
  assertOfficialArcaRcelUrl(page.url(), "la captura de identidad del emisor");
  const bodyText = await page.locator("body").innerText({ timeout: 3000 });
  const matches = meaningfulLines(bodyText)
    .map((line) => line.match(/^Representando a:[ \t]*([0-9]{11}|[0-9]{2}-[0-9]{8}-[0-9])[ \t]*-[ \t]*(.+)$/i))
    .filter((match): match is RegExpMatchArray => match !== null);

  if (matches.length !== 1) {
    throw new Error(`Identidad del emisor: se esperaba una única línea visible "Representando a" y se encontraron ${matches.length}.`);
  }

  const issuerCuit = onlyDigits(matches[0]?.[1] ?? "");
  const issuer = (matches[0]?.[2] ?? "").trim();
  if (!isValidCuit(issuerCuit) || !issuer) {
    throw new Error("ARCA no mostró una identidad completa y válida para el emisor representado.");
  }
  if (issuerCuit !== canonicalCuit(expectedIssuerCuit, "job")) {
    throw new Error("El CUIT visible del emisor representado no coincide con el job.");
  }

  return { issuer, issuerCuit };
}

/**
 * Extrae exclusivamente el bloque delimitado por "Datos del Emisor" y
 * "Datos del Receptor". Nunca toma datos del encabezado global ni del receptor.
 */
export function extractIssuerSummaryEvidence(bodyText: string): IssuerSummaryBlockEvidence {
  const lines = meaningfulLines(bodyText);
  const issuerHeadings = indexesOfHeading(lines, "datos del emisor");
  if (issuerHeadings.length !== 1) {
    throw new Error(`Resumen fiscal: se esperaba un único bloque Datos del Emisor y se encontraron ${issuerHeadings.length}.`);
  }

  const issuerStart = issuerHeadings[0] as number;
  const recipientHeadings = indexesOfHeading(lines, "datos del receptor").filter((index) => index > issuerStart);
  if (recipientHeadings.length !== 1) {
    throw new Error("Resumen fiscal: el bloque Datos del Emisor no tiene un único cierre Datos del Receptor.");
  }

  const issuerLines = lines.slice(issuerStart + 1, recipientHeadings[0]);
  return {
    issuer: uniqueLabeledValue(issuerLines, /^Raz[oó]n Social[ \t]+(.+)$/i, "Razón Social"),
    issuerCommercialAddress: uniqueLabeledValue(issuerLines, /^Domicilio[ \t]+(.+)$/i, "Domicilio"),
  };
}

export function assertIssuerEvidenceMatches(
  summary: IssuerSummaryBlockEvidence,
  control: IssuerControlEvidence,
  expectedIssuerCuits: readonly string[],
): IssuerSummaryEvidence {
  const expected = expectedIssuerCuits.map((value) => canonicalCuit(value, "sesión/job/credencial"));
  if (new Set(expected).size !== 1) {
    throw new Error("La identidad canónica del emisor no coincide entre la sesión, el job y la credencial.");
  }
  if (control.issuerCuit !== expected[0]) {
    throw new Error("El CUIT del emisor representado no coincide con la sesión, el job y la credencial.");
  }
  if (normalizeText(summary.issuer) !== normalizeText(control.issuer)) {
    throw new Error("La razón social del bloque Datos del Emisor no coincide con el emisor representado visible.");
  }
  return { ...summary, issuerCuit: control.issuerCuit };
}

function meaningfulLines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function indexesOfHeading(lines: readonly string[], expected: string): number[] {
  const normalizedExpected = normalizeText(expected);
  const indexes: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (normalizeText(lines[index] ?? "") === normalizedExpected) indexes.push(index);
  }
  return indexes;
}

function uniqueLabeledValue(lines: readonly string[], pattern: RegExp, label: string): string {
  const matches = lines
    .map((line) => line.match(pattern)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
  if (matches.length !== 1) {
    throw new Error(`Resumen fiscal: el bloque Datos del Emisor debe contener un único campo ${label}; se encontraron ${matches.length}.`);
  }
  return matches[0] as string;
}

function canonicalCuit(value: string, source: string): string {
  const cuit = onlyDigits(value);
  if (!isValidCuit(cuit)) throw new Error(`El CUIT de ${source} no es válido.`);
  return cuit;
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
