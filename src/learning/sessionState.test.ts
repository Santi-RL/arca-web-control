import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildLearningControlUrl, currentLearningStateSchema, parseCurrentLearningState } from "./sessionState.js";

const validState = {
  version: 1 as const,
  launchId: "00000000-0000-4000-8000-000000000001",
  pid: 1234,
  host: "127.0.0.1" as const,
  port: 32123,
  token: "a".repeat(64),
  issuerKey: "20000000001",
  issuerName: "Contribuyente Ficticio",
  capability: "capacidad-ficticia",
  intent: "Observar un flujo simulado",
  directory: path.resolve("test-runtime", "learning"),
};

test("acepta un estado de aprendizaje canónico y fija la URL a loopback", () => {
  const parsed = parseCurrentLearningState(validState);
  assert.equal(buildLearningControlUrl(parsed), "http://127.0.0.1:32123");
  assert.equal(parsed.readyState, "learning");
  assert.equal(parseCurrentLearningState({ ...validState, readyState: "captcha" }).readyState, "captcha");
});

test("rechaza host remoto, puerto inválido y token débil", () => {
  assert.equal(currentLearningStateSchema.safeParse({ ...validState, host: "192.0.2.10" }).success, false);
  assert.equal(currentLearningStateSchema.safeParse({ ...validState, port: 0 }).success, false);
  assert.equal(currentLearningStateSchema.safeParse({ ...validState, port: 65_536 }).success, false);
  assert.equal(currentLearningStateSchema.safeParse({ ...validState, token: "abc" }).success, false);
});

test("rechaza campos adicionales y metadatos incoherentes", () => {
  assert.equal(currentLearningStateSchema.safeParse({ ...validState, extra: true }).success, false);
  assert.equal(currentLearningStateSchema.safeParse({ ...validState, issuerKey: "20000000002" }).success, false);
  assert.equal(currentLearningStateSchema.safeParse({ ...validState, directory: "relative" }).success, false);
  assert.equal(currentLearningStateSchema.safeParse({ ...validState, readyState: "otro" }).success, false);
});
