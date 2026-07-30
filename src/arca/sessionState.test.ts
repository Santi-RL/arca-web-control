import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionControlUrl, currentSessionStateSchema, parseCurrentSessionState } from "./sessionState.js";

const validState = {
  version: 2,
  pid: 4_321,
  host: "127.0.0.1",
  port: 49_152,
  token: "a".repeat(64),
  issuerKey: "20000000001",
  issuerName: "Contribuyente Ficticio",
  visibilityMode: "visible",
  artifactDir: "C:\\runtime-ficticio\\sessions\\artifacts\\2030-06-15",
  startedAt: "2030-06-15T12:30:45.123Z",
  handoffComplete: true,
  state: {
    issuerKey: "20000000001",
    url: "https://portalcf.cloud.afip.gob.ar/portal/app/",
    title: "Portal de prueba",
    readyState: "portal",
    captchaVisible: false,
    pageCount: 1,
    artifactDir: "C:\\runtime-ficticio\\sessions\\artifacts\\2030-06-15",
    visibilityMode: "visible",
  },
} as const;

test("acepta un current.json canónico y construye siempre una URL loopback", () => {
  const parsed = parseCurrentSessionState(validState);
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(buildSessionControlUrl(parsed, "/status"), "http://127.0.0.1:49152/status");
});

test("rechaza un host remoto antes de construir una conexión", () => {
  assert.equal(currentSessionStateSchema.safeParse({ ...validState, host: "203.0.113.10" }).success, false);
  assert.throws(() => parseCurrentSessionState({ ...validState, host: "localhost" }), /no se realizará ninguna conexión/i);
});

test("rechaza puertos fuera de rango o no enteros", () => {
  for (const port of [0, 65_536, 12.5, Number.NaN]) {
    assert.equal(currentSessionStateSchema.safeParse({ ...validState, port }).success, false);
  }
});

test("rechaza tokens débiles, truncados o con formato distinto", () => {
  for (const token of ["a".repeat(63), "a".repeat(65), "z".repeat(64), "A".repeat(64), "token-local"]) {
    assert.equal(currentSessionStateSchema.safeParse({ ...validState, token }).success, false);
  }
});

test("rechaza CUIT, fecha y estado interno incoherentes", () => {
  assert.equal(currentSessionStateSchema.safeParse({ ...validState, issuerKey: "20000000002" }).success, false);
  assert.equal(currentSessionStateSchema.safeParse({ ...validState, startedAt: "2030-06-15" }).success, false);
  assert.equal(currentSessionStateSchema.safeParse({ ...validState, state: { ...validState.state, visibilityMode: "production-hidden" } }).success, false);
});
