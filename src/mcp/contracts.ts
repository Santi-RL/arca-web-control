import { z } from "zod";

export const mcpToolNames = [
  "arca_session_start", "arca_session_status", "arca_session_stop",
  "arca_learn_start", "arca_learn_resume_authentication", "arca_learn_note", "arca_learn_checkpoint", "arca_learn_finish",
  "arca_prepare_invoice_chat", "arca_prepare_invoice", "arca_emit_prepared_invoice", "arca_download_pdf",
] as const;

export const sessionStartInput = { issuerKey: z.string().min(1), productionHidden: z.boolean().default(false), capability: z.string().optional() };
export const learnStartInput = { issuerKey: z.string().min(1), capability: z.string().regex(/^[a-z0-9-]+$/), intent: z.string().min(1).max(500) };
export const textInput = { text: z.string().min(1).max(2000) };
export const checkpointInput = { name: z.string().min(1).max(120) };
export const prepareInput = { jobPath: z.string().min(1) };
export const prepareChatInput = {
  intentId: z.string().uuid().describe("UUID generado por el agente para esta intención; se reutiliza solo al reintentar la misma factura."),
  intentRevision: z.number().int().min(1).max(9999).default(1).describe("Revisión privada del borrador; solo se incrementa tras una corrección humana previa al primer clic irreversible."),
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
};
export const emitInput = { preparedInvoiceId: z.string().uuid(), confirmation: z.literal("EMITIR") };
export const downloadInput = { outputPath: z.string().min(1).regex(/\.pdf$/i, "El destino debe ser un nombre PDF relativo a downloads.") };
