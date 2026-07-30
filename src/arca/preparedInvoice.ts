import { createHash, randomUUID } from "node:crypto";
import { isValidCuit } from "../jobs/schema.js";
import { ResolvedInvoiceJob } from "../types.js";

export type PreparedInvoiceSummary = {
  issueDate: string;
  issueDateSource: "control_arca";
  issuer: string;
  issuerCuit: string;
  issuerCommercialAddress: string;
  voucherType: string;
  pointOfSale: string;
  concept: string;
  currency: "ARS";
  billingPeriodFrom?: string;
  billingPeriodTo?: string;
  dueDate?: string;
  recipientCuit: string;
  recipientName?: string;
  recipientVatCondition?: string;
  recipientCommercialAddress?: string;
  saleCondition?: string;
  description: string;
  quantity: string;
  unitPrice: string;
  subtotal: string;
  total: string;
  /** Alias conservado para consumidores anteriores; siempre coincide con total. */
  amount: string;
  rawContainsExpected: boolean;
  missingExpectedSignals: string[];
};

export type PreparedInvoiceState = {
  preparedInvoiceId: string;
  capabilityId: string;
  operationId: string;
  issuerKey: string;
  job: ResolvedInvoiceJob;
  jobHash: string;
  summary: PreparedInvoiceSummary;
  pageFingerprint: string;
  createdAt: string;
  expiresAt: string;
};

export class PreparedInvoiceStore {
  private active?: PreparedInvoiceState;

  create(input: Omit<PreparedInvoiceState, "preparedInvoiceId" | "jobHash" | "createdAt" | "expiresAt"> & { preparedInvoiceId?: string }, now = new Date()): PreparedInvoiceState {
    if (this.active) {
      throw new Error("Ya existe una preparación activa. Debe invalidarse de forma explícita antes de crear otra.");
    }
    assertIssuerInvariant(input.issuerKey, input.job.issuerKey, input.summary);
    assertCurrencyInvariant(input.job, input.summary);
    const state: PreparedInvoiceState = {
      ...input,
      preparedInvoiceId: input.preparedInvoiceId ?? randomUUID(),
      jobHash: hashCanonicalJob(input.job),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.valueOf() + 60 * 60 * 1000).toISOString(),
    };
    this.active = deepFreeze(state);
    return state;
  }

  require(preparedInvoiceId: string, issuerKey: string, pageFingerprint: string, now = new Date()): PreparedInvoiceState {
    const state = this.active;
    if (!state || state.preparedInvoiceId !== preparedInvoiceId) throw new Error("La preparación no existe o fue invalidada.");
    if (state.issuerKey !== issuerKey) throw new Error("La preparación pertenece a otro emisor.");
    if (Date.parse(state.expiresAt) <= now.valueOf()) {
      this.active = undefined;
      throw new Error("La preparación venció. Volvé a ejecutar prepare-invoice.");
    }
    if (state.pageFingerprint !== pageFingerprint) {
      this.active = undefined;
      throw new Error("La página cambió después de preparar la factura. La preparación fue invalidada.");
    }
    if (state.jobHash !== hashCanonicalJob(state.job)) throw new Error("La preparación fue alterada y no es válida.");
    assertIssuerInvariant(state.issuerKey, state.job.issuerKey, state.summary);
    assertCurrencyInvariant(state.job, state.summary);
    return state;
  }

  invalidate(): PreparedInvoiceState | undefined {
    const previous = this.active;
    this.active = undefined;
    return previous;
  }

  get current(): PreparedInvoiceState | undefined {
    return this.active;
  }
}

function assertIssuerInvariant(issuerKey: string, jobIssuerKey: string, summary: PreparedInvoiceSummary): void {
  const sessionCuit = issuerKey.replace(/\D/g, "");
  const jobCuit = jobIssuerKey.replace(/\D/g, "");
  const summaryCuit = summary.issuerCuit?.replace(/\D/g, "") ?? "";
  if (!summary.issuer?.trim() || !summary.issuerCommercialAddress?.trim() || !isValidCuit(summaryCuit)) {
    throw new Error("La preparación no contiene una identidad completa del emisor verificada por ARCA.");
  }
  if (sessionCuit !== jobCuit || summaryCuit !== sessionCuit) {
    throw new Error("La identidad del emisor preparada no coincide con la sesión y el job.");
  }
}

function assertCurrencyInvariant(job: ResolvedInvoiceJob, summary: PreparedInvoiceSummary): void {
  if (job.currency !== "ARS" || summary.currency !== "ARS" || summary.currency !== job.currency) {
    throw new Error("La preparación no contiene moneda local ARS verificada de forma consistente.");
  }
}

export function hashCanonicalJob(job: ResolvedInvoiceJob): string {
  return createHash("sha256").update(stableStringify(job)).digest("hex");
}

export function fingerprintPage(url: string, title: string, bodyText: string): string {
  const safeUrl = new URL(url);
  safeUrl.search = "";
  safeUrl.hash = "";
  const material = [safeUrl.toString(), title.trim(), normalize(bodyText)].join("\n");
  return createHash("sha256").update(material).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
