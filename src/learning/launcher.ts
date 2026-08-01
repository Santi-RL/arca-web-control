export const learningShutdownMessage = Object.freeze({ type: "shutdown" } as const);

export function isLearningShutdownMessage(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === learningShutdownMessage.type;
}

export function buildLearningWorkerArgs(scriptPath: string, args: string[]): string[] {
  return ["--import", "tsx", scriptPath, ...args];
}

export function replaceLearningIssuerWithCuit(args: string[], cuit: string): string[] {
  const indexes = args.flatMap((value, index) => value === "--issuer" ? [index] : []);
  if (indexes.length !== 1 || !/^\d{11}$/u.test(cuit)) {
    throw new Error("El inicio de aprendizaje requiere un único emisor resuelto por CUIT.");
  }
  const index = indexes[0] as number;
  if (!args[index + 1] || args[index + 1]?.startsWith("--")) {
    throw new Error("Falta el valor de --issuer para iniciar el aprendizaje.");
  }
  const normalized = [...args];
  normalized[index + 1] = cuit;
  return normalized;
}
