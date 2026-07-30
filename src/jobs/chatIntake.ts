import { z } from "zod";
import { privateInvoiceIntakeSchema, type PrivateInvoiceIntake } from "./privateIntake.js";
import { invoiceJobV2Schema } from "./schema.js";

const conversationalInputSchema = z.object({
  intentId: z.string().uuid(),
  intentRevision: z.number().int().min(1).max(9999).default(1),
  issuerSelector: z.string().trim().min(1).max(200),
  recipientCuit: z.string().trim().min(1),
  recipientName: z.string().trim().min(1).optional(),
  recipientVatCondition: z.string().trim().min(1),
  recipientCommercialAddress: z.string().trim().min(1).optional(),
  pointOfSale: z.union([z.string(), z.number()]),
  date: z.string().trim().min(1),
  billingPeriodFrom: z.string().trim().min(1),
  billingPeriodTo: z.string().trim().min(1),
  dueDate: z.string().trim().min(1).optional(),
  saleCondition: z.string().trim().min(1),
  description: z.string().trim().min(1).max(1000),
  amount: z.union([z.string(), z.number()]),
}).strict();

export function normalizeConversationalInvoiceInput(raw: unknown): PrivateInvoiceIntake {
  const input = conversationalInputSchema.parse(raw);
  const normalized = {
    ...input,
    recipientCuit: normalizeCuit(input.recipientCuit),
    pointOfSale: String(input.pointOfSale).trim(),
    date: normalizeDate(input.date, "fecha de comprobante"),
    billingPeriodFrom: normalizeDate(input.billingPeriodFrom, "período desde"),
    billingPeriodTo: normalizeDate(input.billingPeriodTo, "período hasta"),
    dueDate: normalizeDueDate(input.dueDate),
    saleCondition: normalizeConversationalLabel(input.saleCondition, "condición de venta"),
    amount: normalizeAmount(input.amount),
  };
  const intake = privateInvoiceIntakeSchema.parse(normalized);
  invoiceJobV2Schema.parse({
    schemaVersion: 2,
    operationId: "validation-only",
    issuerKey: "20000000001",
    recipientCuit: intake.recipientCuit,
    recipientName: intake.recipientName,
    recipientVatCondition: intake.recipientVatCondition,
    recipientCommercialAddress: intake.recipientCommercialAddress,
    voucherType: "Factura C",
    pointOfSale: intake.pointOfSale,
    date: intake.date,
    concept: "Servicios",
    currency: "ARS",
    billingPeriodFrom: intake.billingPeriodFrom,
    billingPeriodTo: intake.billingPeriodTo,
    dueDate: intake.dueDate,
    saleCondition: intake.saleCondition,
    description: intake.description,
    amount: intake.amount,
  });
  return intake;
}

function normalizeConversationalLabel(value: string, label: string): string {
  const normalized = value.trim().replace(/[.,;:]+$/u, "").trim();
  if (!normalized) throw new Error(`${label}: falta un valor reconocible.`);
  return normalized;
}

export function parseConversationalInvoiceJson(raw: string): PrivateInvoiceIntake {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("La entrada privada no contiene un JSON válido.");
  }
  return normalizeConversationalInvoiceInput(parsed);
}

function normalizeCuit(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 11) throw new Error("El CUIT receptor debe contener exactamente once dígitos.");
  return digits;
}

function normalizeDate(value: string, label: string): string {
  const trimmed = value.trim();
  const local = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(trimmed);
  const candidate = local ? `${local[3]}-${local[2]}-${local[1]}` : trimmed;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) {
    throw new Error(`${label}: usá DD/MM/AAAA o AAAA-MM-DD.`);
  }
  const date = new Date(`${candidate}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== candidate) {
    throw new Error(`${label}: la fecha no existe.`);
  }
  return candidate;
}

function normalizeDueDate(value: string | undefined): string | undefined {
  if (!value || /^(?:default|predeterminad[oa]|por defecto)$/iu.test(value.trim())) return undefined;
  return normalizeDate(value, "fecha de vencimiento");
}

function normalizeAmount(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new Error("El importe debe ser positivo y finito.");
    if (!/^\d+(?:\.\d{1,2})?$/u.test(String(value))) {
      throw new Error("El importe numérico no puede requerir redondeo; usá como máximo dos decimales o enviá una cadena exacta.");
    }
    return value.toFixed(2);
  }
  const compact = value.trim().replace(/^(?:ARS|\$)\s*/iu, "").replace(/\s+/g, "");
  if (/^\d{1,3}(?:\.\d{3})*,\d{2}$/u.test(compact)) return compact.replace(/\./g, "").replace(",", ".");
  if (/^\d+,\d{2}$/u.test(compact)) return compact.replace(",", ".");
  if (/^\d+\.\d{2}$/u.test(compact)) return compact;
  throw new Error("El importe debe incluir exactamente dos decimales, por ejemplo 123.456,78 o 123456.78.");
}
