import { sanitizeErrorMessage } from "../arca/publicErrors.js";

export function publicLearningError(commandType: string | undefined, error: unknown): string {
  if (commandType === "fill-input") return "No se pudo completar el input. El valor privado fue redactado; ejecutá inspect nuevamente antes de reintentar.";
  return sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
}
