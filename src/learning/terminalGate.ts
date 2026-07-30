export type LearningTerminalCommand = "finish" | "abort";

export class LearningTerminalGate {
  private state: "open" | LearningTerminalCommand = "open";

  assertOpen(): void {
    if (this.state !== "open") throw new Error(`El aprendizaje ya está cerrándose mediante ${this.state}; no se aceptan más comandos.`);
  }

  begin(command: LearningTerminalCommand): void {
    this.assertOpen();
    this.state = command;
  }
}
