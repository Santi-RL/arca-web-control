import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { OperationLedger } from "./operationLedger.js";

test("operationId se reserva de forma atómica", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const ledger = new OperationLedger(directory);
  const results = await Promise.allSettled([
    ledger.claimPreparation("operation-race-001", "hash-a", "prepared-a"),
    ledger.claimPreparation("operation-race-001", "hash-a", "prepared-b"),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
});

test("una preparación invalidada puede reclamarse solo con el mismo hash", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const ledger = new OperationLedger(directory);
  await ledger.claimPreparation("operation-retry-001", "hash-a", "prepared-a");
  await assert.rejects(() => ledger.claimPreparation("operation-retry-001", "hash-a", "prepared-b"), /solo failed_before_emit/);
  await ledger.markFailedBeforeEmit("operation-retry-001", "prepared-a", "hash-a", "Preparación invalidada de forma controlada.");
  await ledger.claimPreparation("operation-retry-001", "hash-a", "prepared-b");
  assert.equal((await ledger.get("operation-retry-001"))?.preparedInvoiceId, "prepared-b");
  await assert.rejects(() => ledger.claimPreparation("operation-retry-001", "hash-b", "prepared-c"), /otra preparación activa/);
});

test("la emisión exige la preparación vigente y aplica transiciones CAS", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const ledger = new OperationLedger(directory);
  await ledger.claimPreparation("operation-cas-001", "hash", "prepared-new");
  await assert.rejects(() => ledger.claimEmission("operation-cas-001", "prepared-old", "hash"), /no coincide/);
  await ledger.attachPreparedIssuer("operation-cas-001", "prepared-new", "hash", { cuit: "20000000001", name: "EMISOR FICTICIO" });
  await ledger.claimEmission("operation-cas-001", "prepared-new", "hash");
  await assert.rejects(
    () => ledger.markEmitted("operation-cas-001", "prepared-new", "hash", { voucherNumber: "1" }),
    /estado emitted exige/i,
  );
  await ledger.markEmitted("operation-cas-001", "prepared-new", "hash", {
    voucherNumber: "00001-00000042",
    cae: "99999999999999",
    pdfPath: path.resolve(directory, "factura.pdf"),
    metadataPath: path.resolve(directory, "factura.json"),
    pdfSha256: "a".repeat(64),
  });
  assert.deepEqual((await ledger.get("operation-cas-001"))?.issuer, { cuit: "20000000001", name: "EMISOR FICTICIO" });
  await assert.rejects(() => ledger.claimPreparation("operation-cas-001", "hash", "prepared-next"), /emitida/);
});

test("unknown bloquea cualquier reintento automático", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const ledger = new OperationLedger(directory);
  await seedLedger(directory, { operationId: "operation-unknown-001", status: "unknown", jobHash: "hash" });
  await assert.rejects(() => ledger.claimPreparation("operation-unknown-001", "hash-distinto", "prepared"), (error: Error) => {
    assert.match(error.message, /unknown.*prohibido.*reconciliá/i);
    assert.doesNotMatch(error.message, /generá|operationId nuevo/i);
    return true;
  });
});

test("unknown solo se reconcilia como emitted con evidencia fiscal completa y el mismo job", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const ledger = new OperationLedger(directory);
  await seedLedger(directory, { operationId: "operation-reconcile-001", status: "unknown", jobHash: "hash-a", preparedInvoiceId: "prepared-a" });
  const receipt = {
    voucherNumber: "00001-00000042",
    cae: "99999999999999",
    pdfPath: path.resolve(directory, "factura.pdf"),
    metadataPath: path.resolve(directory, "factura.json"),
    pdfSha256: "a".repeat(64),
  };
  await assert.rejects(() => ledger.reconcileUnknownAsEmitted("operation-reconcile-001", "hash-b", receipt), /mismo job/i);
  await assert.rejects(
    () => ledger.reconcileUnknownAsEmitted("operation-reconcile-001", "hash-a", { ...receipt, cae: undefined }),
    /CAE verificable/i,
  );
  const reconciled = await ledger.reconcileUnknownAsEmitted("operation-reconcile-001", "hash-a", receipt);
  assert.equal(reconciled.status, "emitted");
  assert.deepEqual(reconciled.receipt, receipt);
  await assert.rejects(() => ledger.reconcileUnknownAsEmitted("operation-reconcile-001", "hash-a", receipt), /desde emitted/i);
});

test("una preparación cuya página pudo cambiar se bloquea como unknown", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const ledger = new OperationLedger(directory);
  await ledger.claimPreparation("op-page-drift", "hash-a", "prepared-a");
  const unknown = await ledger.markPreparedUnknown("op-page-drift", "prepared-a", "hash-a", "La página cambió después del resumen.");
  assert.equal(unknown.status, "unknown");
  await assert.rejects(() => ledger.claimPreparation("op-page-drift", "hash-a", "prepared-b"), /estado unknown/);
});

test("un estado desconocido bloquea el reintento", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const operationId = "operation-corrupt-status-001";
  const digest = createHash("sha256").update(operationId, "utf8").digest("hex");
  await fs.writeFile(path.join(directory, `${digest}.json`), JSON.stringify({
    operationId,
    status: "emittted",
    jobHash: "hash",
    updatedAt: new Date().toISOString(),
  }));
  const ledger = new OperationLedger(directory);
  await assert.rejects(() => ledger.claimPreparation(operationId, "hash", "prepared"), /estado inválido/);
});

test("IDs que antes colisionaban conservan archivos independientes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const ledger = new OperationLedger(directory);
  await seedLedger(directory, { operationId: "invoice:2026", status: "unknown", jobHash: "hash-a" });
  await seedLedger(directory, { operationId: "invoice_2026", status: "failed_before_emit", jobHash: "hash-b" });
  assert.equal((await ledger.get("invoice:2026"))?.jobHash, "hash-a");
  assert.equal((await ledger.get("invoice_2026"))?.jobHash, "hash-b");
});


test("un lock de archivo legado no bloquea el mutex del sistema operativo", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const operationId = "operation-stale-lock-001";
  const digest = createHash("sha256").update(operationId, "utf8").digest("hex");
  await fs.writeFile(path.join(directory, `${digest}.json.lock`), JSON.stringify({ pid: 2147483647, operationId, claimedAt: new Date().toISOString() }));
  const ledger = new OperationLedger(directory);
  const prepared = await ledger.claimPreparation(operationId, "hash", "prepared");
  assert.equal(prepared.status, "prepared");
  assert.equal((await fs.stat(path.join(directory, `${digest}.json.lock`))).isFile(), true);
});

test("un estado legado emitted sigue bloqueando después de actualizar", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const operationId = "invoice:legacy-2026";
  await fs.writeFile(path.join(directory, "invoice_legacy-2026.json"), JSON.stringify({ operationId, status: "emitted", jobHash: "hash", updatedAt: new Date().toISOString() }));
  const ledger = new OperationLedger(directory);
  assert.equal((await ledger.get(operationId))?.status, "emitted");
  await assert.rejects(() => ledger.claimPreparation(operationId, "hash", "prepared"), /emitida/);
});

test("una preparación huérfana del mismo job puede reconstruirse sin abrir una segunda mientras el dueño vive", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const alive = new Set([31001]);
  const first = new OperationLedger(directory, {
    pid: 31001,
    ownerToken: "11111111-1111-4111-8111-111111111111",
    isProcessAlive: (pid) => alive.has(pid),
  });
  const replacement = new OperationLedger(directory, {
    pid: 31002,
    ownerToken: "22222222-2222-4222-8222-222222222222",
    isProcessAlive: (pid) => alive.has(pid),
  });

  await first.claimPreparation("operation-orphan-prepared", "hash-a", "prepared-a");
  await assert.rejects(
    () => replacement.claimPreparation("operation-orphan-prepared", "hash-a", "prepared-b"),
    /estado prepared/,
  );
  alive.delete(31001);
  const reclaimed = await replacement.claimPreparation("operation-orphan-prepared", "hash-a", "prepared-b");
  assert.equal(reclaimed.status, "prepared");
  assert.equal(reclaimed.preparedInvoiceId, "prepared-b");
  await assert.rejects(
    () => first.markFailedBeforeEmit("operation-orphan-prepared", "prepared-a", "hash-a", "sesión anterior"),
    /preparación vigente no coincide/,
  );
});

test("una emisión cuyo proceso terminó se normaliza a unknown y nunca vuelve a prepararse", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const alive = new Set([32001]);
  const emitter = new OperationLedger(directory, {
    pid: 32001,
    ownerToken: "33333333-3333-4333-8333-333333333333",
    isProcessAlive: (pid) => alive.has(pid),
  });
  const recovery = new OperationLedger(directory, {
    pid: 32002,
    ownerToken: "44444444-4444-4444-8444-444444444444",
    isProcessAlive: (pid) => alive.has(pid),
  });

  await emitter.claimPreparation("operation-orphan-emitting", "hash-a", "prepared-a");
  await emitter.attachPreparedIssuer("operation-orphan-emitting", "prepared-a", "hash-a", { cuit: "20000000001", name: "EMISOR FICTICIO" });
  await emitter.claimEmission("operation-orphan-emitting", "prepared-a", "hash-a");
  assert.equal((await recovery.get("operation-orphan-emitting"))?.status, "emitting");
  alive.delete(32001);
  const normalized = await recovery.get("operation-orphan-emitting");
  assert.equal(normalized?.status, "unknown");
  assert.match(normalized?.detail ?? "", /nunca se reintentará/i);
  assert.deepEqual(normalized?.issuer, { cuit: "20000000001", name: "EMISOR FICTICIO" });
  await assert.rejects(
    () => recovery.claimPreparation("operation-orphan-emitting", "hash-a", "prepared-b"),
    /estado unknown/,
  );
});

test("peek observa una emisión huérfana sin normalizar ni modificar el ledger", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const operationId = "operation-orphan-emitting-passive";
  const alive = new Set([32501]);
  const emitter = new OperationLedger(directory, {
    pid: 32501,
    ownerToken: "77777777-7777-4777-8777-777777777777",
    isProcessAlive: (pid) => alive.has(pid),
  });
  const observer = new OperationLedger(directory, {
    pid: 32502,
    ownerToken: "88888888-8888-4888-8888-888888888888",
    isProcessAlive: (pid) => alive.has(pid),
  });

  await emitter.claimPreparation(operationId, "hash-a", "prepared-a");
  await emitter.attachPreparedIssuer(operationId, "prepared-a", "hash-a", { cuit: "20000000001", name: "EMISOR FICTICIO" });
  await emitter.claimEmission(operationId, "prepared-a", "hash-a");
  alive.delete(32501);

  const digest = createHash("sha256").update(operationId, "utf8").digest("hex");
  const ledgerPath = path.join(directory, `${digest}.json`);
  const before = await fs.readFile(ledgerPath);
  const observed = await observer.peek(operationId);
  const after = await fs.readFile(ledgerPath);

  assert.equal(observed?.status, "emitting");
  assert.deepEqual(observed, JSON.parse(before.toString("utf8")));
  assert.deepEqual(after, before);
});

test("una emisión demasiado antigua se vuelve unknown aunque su PID haya sido reutilizado", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  let clock = new Date("2030-06-15T12:00:00.000Z");
  const emitter = new OperationLedger(directory, {
    pid: 33001,
    ownerToken: "55555555-5555-4555-8555-555555555555",
    isProcessAlive: () => true,
    now: () => clock,
  });
  await emitter.claimPreparation("operation-old-emitting", "hash-a", "prepared-a");
  await emitter.claimEmission("operation-old-emitting", "prepared-a", "hash-a");

  clock = new Date("2030-06-15T12:16:00.000Z");
  const observer = new OperationLedger(directory, {
    pid: 33002,
    ownerToken: "66666666-6666-4666-8666-666666666666",
    isProcessAlive: () => true,
    now: () => clock,
  });
  assert.equal((await observer.get("operation-old-emitting"))?.status, "unknown");
});

test("una falla conocida antes del primer clic vuelve a failed_before_emit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const ledger = new OperationLedger(directory);
  await ledger.claimPreparation("operation-pre-click", "hash-a", "prepared-a");
  await ledger.claimEmission("operation-pre-click", "prepared-a", "hash-a");
  const failed = await ledger.markFailedBeforeFirstClick("operation-pre-click", "prepared-a", "hash-a", "La reserva externa falló antes del clic.");
  assert.equal(failed.status, "failed_before_emit");
  await ledger.claimPreparation("operation-pre-click", "hash-b", "prepared-b");
  assert.equal((await ledger.get("operation-pre-click"))?.jobHash, "hash-b");
});

async function seedLedger(directory: string, entry: { operationId: string; status: "unknown" | "failed_before_emit"; jobHash: string; preparedInvoiceId?: string }): Promise<void> {
  const digest = createHash("sha256").update(entry.operationId, "utf8").digest("hex");
  await fs.writeFile(path.join(directory, `${digest}.json`), JSON.stringify({ ...entry, updatedAt: new Date().toISOString() }));
}
