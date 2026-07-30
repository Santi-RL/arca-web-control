import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimePaths } from "../config/runtimePaths.js";
import { assertInvoiceRegimeConfigured, issuerProfileSchema, loadIssuerProfile, removeIssuerRegime, saveIssuerRegime } from "./profile.js";

test("el perfil privado identifica al emisor por CUIT y evita regímenes duplicados", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arca-issuer-"));
  const runtime = runtimePaths(root);
  const empty = await loadIssuerProfile("20000000001", runtime);
  assert.deepEqual(empty.specificRegimes, []);
  const saved = await saveIssuerRegime("20000000001", "meat-remit", "101011", runtime);
  assert.equal(saved.specificRegimes[0]?.activityCode, "101011");
  const replaced = await saveIssuerRegime("20000000001", "meat-remit", "101012", runtime);
  assert.equal(replaced.specificRegimes.length, 1);
  assert.equal(replaced.specificRegimes[0]?.activityCode, "101012");
  await assert.rejects(() => assertInvoiceRegimeConfigured({ issuerKey: "20000000001", specificRegime: "meat-remit", activity: "101012" }, runtime), /no admite todavía/);
  await assert.rejects(() => assertInvoiceRegimeConfigured({ issuerKey: "20000000001", specificRegime: "meat-remit", activity: "101011" }, runtime), /no coincide/);
  const removed = await removeIssuerRegime("20000000001", "meat-remit", runtime);
  assert.deepEqual(removed.specificRegimes, []);
});

test("el perfil rechaza códigos de actividad y duplicados inválidos", () => {
  assert.throws(() => issuerProfileSchema.parse({ schemaVersion: 1, issuerCuit: "20000000001", specificRegimes: [
    { id: "meat-remit", activityCode: "1", validatedAt: "2026-07-29", source: "https://example.invalid" },
  ] }), /seis dígitos/);
  assert.throws(() => issuerProfileSchema.parse({ schemaVersion: 1, issuerCuit: "20000000001", specificRegimes: [
    { id: "meat-remit", activityCode: "101011", validatedAt: "2026-07-29", source: "https://example.invalid" },
    { id: "meat-remit", activityCode: "101012", validatedAt: "2026-07-29", source: "https://example.invalid" },
  ] }), /repetido/);
});

function runtimePaths(root: string): RuntimePaths {
  return {
    root,
    config: path.join(root, "config"),
    profiles: path.join(root, "profiles"),
    issuers: path.join(root, "issuers"),
    sessions: path.join(root, "sessions"),
    learning: path.join(root, "learning"),
    ledger: path.join(root, "ledger"),
    privateJobs: path.join(root, "jobs", "private"),
    privateImport: path.join(root, "private-import"),
    guided: path.join(root, "guided"),
    logs: path.join(root, "logs"),
    downloads: path.join(root, "downloads"),
  };
}
