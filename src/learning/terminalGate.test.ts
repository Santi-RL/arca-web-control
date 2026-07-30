import assert from "node:assert/strict";
import test from "node:test";
import { LearningTerminalGate } from "./terminalGate.js";

test("el primer comando terminal bloquea de forma síncrona todos los comandos posteriores", () => {
  const gate = new LearningTerminalGate();
  gate.assertOpen();
  gate.begin("finish");
  assert.throws(() => gate.assertOpen(), /cerrándose/);
  assert.throws(() => gate.begin("abort"), /cerrándose/);
});
