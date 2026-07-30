export const learningShutdownMessage = Object.freeze({ type: "shutdown" } as const);

export function isLearningShutdownMessage(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === learningShutdownMessage.type;
}

export function buildLearningWorkerArgs(scriptPath: string, args: string[]): string[] {
  return ["--import", "tsx", scriptPath, ...args];
}
