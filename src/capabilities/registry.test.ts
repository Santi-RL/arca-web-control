import assert from "node:assert/strict";
import test from "node:test";
import { loadCapabilityRegistry, parseCapabilityManifest, requireHiddenCapability, requireInvoiceCapability } from "./registry.js";

const validHiddenManifest = {
  id: "invoice-hidden-test",
  version: 1,
  title: "Factura ficticia de prueba",
  maturity: "fast_path",
  hiddenAllowed: true,
  commands: ["status", "snapshot", "screenshot", "prepare-invoice", "emit-prepared-invoice"],
  irreversibleAction: "Emitir comprobante ficticio",
  confirmation: "EMITIR",
  recovery: "Detenerse ante cualquier desvío.",
  inputSchema: "invoice-job-v2",
  runtimeScope: { kind: "invoice", voucherType: "Factura C", concept: "Servicios", currency: "ARS", itemCount: 1 },
  testEvidence: ["src/capabilities/registry.test.ts"],
  realEvidence: ["docs/estado-y-roadmap.md#evidencia-ficticia"],
  lastValidatedAt: "2030-06-15",
  lastValidatedVisible: true,
} as const;

test("registro carga la capacidad fiscal canónica", async () => {
  const registry = await loadCapabilityRegistry();
  const invoice = registry.find((item) => item.id === "invoice-services-single-item");
  assert.equal(invoice?.maturity, "automated_to_summary");
  assert.equal(invoice?.hiddenAllowed, false);
  assert.deepEqual(invoice?.runtimeScope, {
    kind: "invoice",
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
    itemCount: 1,
  });
});

test("production-hidden permanece deshabilitado sin fast_path aprobado", async () => {
  await assert.rejects(() => requireHiddenCapability("invoice-services-single-item"), /no está habilitada/i);
  await assert.rejects(() => requireInvoiceCapability({
    command: "prepare-invoice",
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
    itemCount: 1,
    requireHidden: true,
  }), /no está habilitada/i);
});

test("el manifiesto aplica los invariantes de production-hidden aunque se edite JSON manualmente", () => {
  assert.equal(parseCapabilityManifest(validHiddenManifest).hiddenAllowed, true);
  assert.throws(() => parseCapabilityManifest({
    ...validHiddenManifest,
    lastValidatedAt: null,
    lastValidatedVisible: false,
  }), /validación visible|fast_path/i);
  assert.throws(() => parseCapabilityManifest({
    ...validHiddenManifest,
    commands: [...validHiddenManifest.commands, "click-text"],
  }), /ruta preparada|modo oculto/i);
  assert.throws(() => parseCapabilityManifest({
    ...validHiddenManifest,
    confirmation: "SI",
  }), /EMITIR/i);
  assert.throws(() => parseCapabilityManifest({
    ...validHiddenManifest,
    realEvidence: [],
  }), /evidencia real|fast_path/i);
});

test("controlled_irreversible no puede declararse manualmente sin pruebas ni evidencia real", () => {
  assert.throws(() => parseCapabilityManifest({
    ...validHiddenManifest,
    maturity: "controlled_irreversible",
    hiddenAllowed: false,
    lastValidatedAt: null,
    lastValidatedVisible: false,
    testEvidence: [],
    realEvidence: [],
  }), /controlled_irreversible.*pruebas.*evidencia real/i);
});

test("el alcance canónico admite preparar Factura C de Servicios y bloquea emisión pendiente de revalidación", async () => {
  const capability = await requireInvoiceCapability({
    command: "prepare-invoice",
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
    itemCount: 1,
  });
  assert.equal(capability.id, "invoice-services-single-item");
  await assert.rejects(() => requireInvoiceCapability({
    command: "emit-prepared-invoice",
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
    itemCount: 1,
  }), /no coincide con una capacidad registrada/i);
});

test("el alcance runtime rechaza Factura A aunque la sesión sea visible", async () => {
  await assert.rejects(() => requireInvoiceCapability({
    command: "prepare-invoice",
    voucherType: "Factura A",
    concept: "Servicios",
    currency: "ARS",
    itemCount: 1,
  }), /no coincide con una capacidad registrada/i);
});

test("el alcance runtime rechaza Productos antes de preparar o emitir", async () => {
  for (const command of ["prepare-invoice", "emit-prepared-invoice"] as const) {
    await assert.rejects(() => requireInvoiceCapability({
      command,
      voucherType: "Factura C",
      concept: "Productos",
      currency: "ARS",
      itemCount: 1,
    }), /no coincide con una capacidad registrada/i);
  }
});

test("el alcance runtime rechaza moneda extranjera antes de preparar o emitir", async () => {
  for (const command of ["prepare-invoice", "emit-prepared-invoice"] as const) {
    await assert.rejects(() => requireInvoiceCapability({
      command,
      voucherType: "Factura C",
      concept: "Servicios",
      currency: "USD",
      itemCount: 1,
    }), /no coincide con una capacidad registrada/i);
  }
});

test("el alcance runtime rechaza variantes de múltiples ítems o capability no registrada", async () => {
  await assert.rejects(() => requireInvoiceCapability({
    command: "prepare-invoice",
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
    itemCount: 2,
  }), /no coincide con una capacidad registrada/i);

  await assert.rejects(() => requireInvoiceCapability({
    command: "emit-prepared-invoice",
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
    itemCount: 1,
    capabilityId: "invoice-unregistered-variant",
  }), /capacidad desconocida/i);
});
