import { OperationLedger } from "./operationLedger.js";
import { PreparedInvoiceState, PreparedInvoiceStore } from "./preparedInvoice.js";

type PreparationLedgerTransitions = Pick<OperationLedger, "markFailedBeforeEmit" | "markPreparedUnknown">;

/**
 * Retira primero la preparación de memoria y recién después persiste su estado.
 * Así, aun si falla el acceso al ledger, el identificador anterior deja de ser
 * utilizable y la mutación que motivó la invalidación queda bloqueada.
 */
export async function invalidatePreparationBeforeMutation(
  store: PreparedInvoiceStore,
  ledger: PreparationLedgerTransitions,
  currentPageFingerprint: () => Promise<string>,
  detail: string,
  options: { recognizedPreClickInterruption?: boolean } = {},
): Promise<PreparedInvoiceState | undefined> {
  const state = store.invalidate();
  if (!state) return undefined;

  const currentFingerprint = await currentPageFingerprint().catch(() => "");
  if (!options.recognizedPreClickInterruption && currentFingerprint !== state.pageFingerprint) {
    await ledger.markPreparedUnknown(state.operationId, state.preparedInvoiceId, state.jobHash, detail);
  } else {
    await ledger.markFailedBeforeEmit(state.operationId, state.preparedInvoiceId, state.jobHash, detail);
  }

  return state;
}
