import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderSkillCapabilities, renderSkillCommands } from "./generate.js";
import { buildPromotedCapabilityManifest, loadCapabilityRegistry, parseCapabilityManifest, requireHiddenCapability, requireInvoiceCapability, requireInvoiceJobCapability, requireInvoiceJobVisibleRevalidation, requireVisibleInvoiceRevalidationCapability } from "./registry.js";

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

const validPendingManifest = {
  ...validHiddenManifest,
  id: "invoice-pending-test",
  maturity: "automated_to_summary",
  hiddenAllowed: false,
  commands: ["status", "snapshot", "screenshot", "prepare-invoice"],
  lastValidatedAt: null,
  lastValidatedVisible: false,
} as const;

test("registro carga la capacidad fiscal canónica", async () => {
  const registry = await loadCapabilityRegistry();
  const invoice = registry.find((item) => item.id === "invoice-services-single-item");
  assert.equal(invoice?.maturity, "controlled_irreversible");
  assert.equal(invoice?.hiddenAllowed, false);
  assert.equal(invoice?.commands.includes("emit-prepared-invoice"), true);
  assert.deepEqual(invoice?.runtimeScope, {
    kind: "invoice",
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
    itemCount: 1,
    recipientKind: "identified-cuit",
  });
});

test("registro separa consumidor final anónimo del receptor identificado y documenta ambos alcances", async () => {
  const registry = await loadCapabilityRegistry();
  const anonymous = registry.find((item) => item.id === "invoice-services-single-item-consumidor-final-anonimo");
  assert.equal(anonymous?.maturity, "controlled_irreversible");
  assert.equal(anonymous?.hiddenAllowed, false);
  assert.equal(anonymous?.commands.includes("emit-prepared-invoice"), true);
  assert.equal(anonymous?.confirmation, "EMITIR");
  assert.deepEqual(anonymous?.runtimeScope, {
    kind: "invoice",
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
    itemCount: 1,
    recipientKind: "anonymous-final-consumer",
  });

  const rendered = renderSkillCapabilities(registry);
  assert.match(rendered, /receptor `identified-cuit`/);
  assert.match(rendered, /receptor `anonymous-final-consumer`/);
  assert.match(renderSkillCommands(registry), /La emisión habilitada.*emit-prepared-invoice/s);
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

test("la promoción irreversible habilita la emisión como una transición atómica", () => {
  assert.throws(
    () => buildPromotedCapabilityManifest(parseCapabilityManifest(validPendingManifest), "controlled_irreversible"),
    /validación humana visible/i,
  );
  const validated = parseCapabilityManifest({
    ...validPendingManifest,
    lastValidatedAt: "2030-06-15",
    lastValidatedVisible: true,
  });
  const promoted = buildPromotedCapabilityManifest(validated, "controlled_irreversible");
  assert.equal(promoted.maturity, "controlled_irreversible");
  assert.equal(promoted.commands.includes("emit-prepared-invoice"), true);
  assert.equal(promoted.hiddenAllowed, false);
  assert.throws(() => buildPromotedCapabilityManifest(promoted, "automated_to_summary"), /no puede reducir/i);
});

test("el alcance canónico admite preparar y emitir ambas Facturas C de Servicios visibles", async () => {
  const capability = await requireInvoiceCapability({
    command: "prepare-invoice",
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
    itemCount: 1,
  });
  assert.equal(capability.id, "invoice-services-single-item");
  assert.equal((await requireInvoiceJobCapability({
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
  }, "prepare-invoice")).id, "invoice-services-single-item");
  assert.equal((await requireInvoiceJobCapability({
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
    recipientKind: "anonymous-final-consumer",
  }, "prepare-invoice")).id, "invoice-services-single-item-consumidor-final-anonimo");
  assert.equal((await requireInvoiceCapability({
    command: "emit-prepared-invoice",
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
    itemCount: 1,
  })).id, "invoice-services-single-item");
  assert.equal((await requireInvoiceCapability({
    command: "emit-prepared-invoice",
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
    itemCount: 1,
    recipientKind: "anonymous-final-consumer",
  })).id, "invoice-services-single-item-consumidor-final-anonimo");
});

test("la revalidación visible admite únicamente un manifiesto pendiente y no reabre capacidades promovidas", async (t) => {
  await assert.rejects(
    () => requireVisibleInvoiceRevalidationCapability("invoice-services-single-item"),
    /estado canónico/i,
  );
  await assert.rejects(
    () => requireVisibleInvoiceRevalidationCapability("invoice-services-single-item-consumidor-final-anonimo"),
    /estado canónico/i,
  );

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arca-pending-revalidation-registry-"));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "invoice-pending-test.json"), JSON.stringify(validPendingManifest));
  const capability = await requireVisibleInvoiceRevalidationCapability("invoice-pending-test", root);
  assert.equal(capability.maturity, "automated_to_summary");
  assert.equal(capability.hiddenAllowed, false);
  assert.equal(capability.commands.includes("emit-prepared-invoice"), false);
  assert.equal((await requireInvoiceJobVisibleRevalidation({
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
  }, capability.id, root)).id, capability.id);
  await assert.rejects(() => requireInvoiceJobVisibleRevalidation({
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
    recipientKind: "anonymous-final-consumer",
  }, capability.id, root), /alcance cerrado/i);
});

test("el alcance runtime rechaza tipos de receptor desconocidos en manifiestos y solicitudes", async () => {
  assert.throws(() => parseCapabilityManifest({
    ...validHiddenManifest,
    runtimeScope: { ...validHiddenManifest.runtimeScope, recipientKind: "persona-sin-identidad" },
  }), /recipientKind/i);
  await assert.rejects(() => requireInvoiceCapability({
    command: "prepare-invoice",
    voucherType: "Factura C",
    concept: "Servicios",
    currency: "ARS",
    itemCount: 1,
    recipientKind: "persona-sin-identidad" as "identified-cuit",
  }), /tipo de receptor no admitido/i);
});

test("la revalidación visible rechaza variantes y manifiestos ya promovidos", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arca-revalidation-registry-"));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "invoice-pending-test.json"), JSON.stringify(validPendingManifest));
  await fs.writeFile(path.join(root, "invoice-hidden-test.json"), JSON.stringify(validHiddenManifest));
  await assert.rejects(() => requireInvoiceJobVisibleRevalidation({
    voucherType: "Factura A",
    concept: "Servicios",
    currency: "ARS",
  }, "invoice-pending-test", root), /alcance cerrado/i);
  await assert.rejects(() => requireVisibleInvoiceRevalidationCapability("invoice-hidden-test", root), /estado canónico/i);
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
