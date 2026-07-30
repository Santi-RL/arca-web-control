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
  await assert.rejects(() => ledger.claimPreparation("operation-retry-001", "hash-b", "prepared-c"), /otro job/);
});

test("la emisión exige la preparación vigente y aplica transiciones CAS", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const ledger = new OperationLedger(directory);
  await ledger.claimPreparation("operation-cas-001", "hash", "prepared-new");
  await assert.rejects(() => ledger.claimEmission("operation-cas-001", "prepared-old", "hash"), /no coincide/);
  await ledger.claimEmission("operation-cas-001", "prepared-new", "hash");
  await ledger.markEmitted("operation-cas-001", "prepared-new", "hash", { voucherNumber: "1" });
  await assert.rejects(() => ledger.claimPreparation("operation-cas-001", "hash", "prepared-next"), /emitted/);
});

test("unknown bloquea cualquier reintento automático", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const ledger = new OperationLedger(directory);
  await ledger.record({ operationId: "operation-unknown-001", status: "unknown", jobHash: "hash" });
  await assert.rejects(() => ledger.claimPreparation("operation-unknown-001", "hash", "prepared"), /unknown/);
});

test("unknown solo se reconcilia como emitted con evidencia fiscal completa y el mismo job", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const ledger = new OperationLedger(directory);
  await ledger.record({ operationId: "operation-reconcile-001", status: "unknown", jobHash: "hash-a", preparedInvoiceId: "prepared-a" });
  const receipt = {
    voucherNumber: "00001-00000042",
    cae: "99999999999999",
    pdfPath: path.resolve(directory, "factura.pdf"),
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
  await ledger.record({ operationId: "invoice:2026", status: "unknown", jobHash: "hash-a" });
  await ledger.record({ operationId: "invoice_2026", status: "failed_before_emit", jobHash: "hash-b" });
  assert.equal((await ledger.get("invoice:2026"))?.jobHash, "hash-a");
  assert.equal((await ledger.get("invoice_2026"))?.jobHash, "hash-b");
});


test("un lock de un PID muerto bloquea hasta revisión manual", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const operationId = "operation-stale-lock-001";
  const digest = createHash("sha256").update(operationId, "utf8").digest("hex");
  await fs.writeFile(path.join(directory, `${digest}.json.lock`), JSON.stringify({ pid: 2147483647, operationId }));
  const ledger = new OperationLedger(directory);
  await assert.rejects(() => ledger.claimPreparation(operationId, "hash", "prepared"), /huérfano/);
  assert.equal((await fs.stat(path.join(directory, `${digest}.json.lock`))).isFile(), true);
});

test("un estado legado emitted sigue bloqueando después de actualizar", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-ledger-"));
  const operationId = "invoice:legacy-2026";
  await fs.writeFile(path.join(directory, "invoice_legacy-2026.json"), JSON.stringify({ operationId, status: "emitted", jobHash: "hash", updatedAt: new Date().toISOString() }));
  const ledger = new OperationLedger(directory);
  assert.equal((await ledger.get(operationId))?.status, "emitted");
  await assert.rejects(() => ledger.claimPreparation(operationId, "hash", "prepared"), /emitted/);
});
