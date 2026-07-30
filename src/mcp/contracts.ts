import { z } from "zod";

export const mcpToolNames = [
  "arca_session_start", "arca_session_status", "arca_session_stop",
  "arca_learn_start", "arca_learn_note", "arca_learn_checkpoint", "arca_learn_finish",
  "arca_prepare_invoice", "arca_emit_prepared_invoice", "arca_download_pdf",
] as const;

export const sessionStartInput = { issuerKey: z.string().min(1), productionHidden: z.boolean().default(false), capability: z.string().optional() };
export const learnStartInput = { issuerKey: z.string().min(1), capability: z.string().regex(/^[a-z0-9-]+$/), intent: z.string().min(1).max(500) };
export const textInput = { text: z.string().min(1).max(2000) };
export const checkpointInput = { name: z.string().min(1).max(120) };
export const prepareInput = { jobPath: z.string().min(1) };
export const emitInput = { preparedInvoiceId: z.string().uuid(), confirmation: z.literal("EMITIR") };
export const downloadInput = { outputPath: z.string().min(1).regex(/\.pdf$/i, "El destino debe ser un nombre PDF relativo a downloads.") };
