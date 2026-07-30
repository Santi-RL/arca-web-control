import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCommandAllowedInSessionMode,
  isAuthorizedSessionRequest,
  parseSessionCommandArgs,
  redactCommandForLog,
  sessionCommandSchema,
} from "./sessionCommands.js";

test("parseSessionCommandArgs interpreta los comandos sin argumentos", () => {
  for (const command of ["status", "snapshot", "screenshot", "pages", "inputs", "select-options", "resume-authentication", "portal"] as const) {
    assert.deepEqual(parseSessionCommandArgs([command]), { type: command });
  }
});

test("parseSessionCommandArgs interpreta únicamente mutaciones especializadas", () => {
  assert.deepEqual(parseSessionCommandArgs(["open-service", "Sistema", "de", "cuentas", "tributarias"]), {
    type: "open-service",
    serviceName: "Sistema de cuentas tributarias",
  });
  assert.deepEqual(parseSessionCommandArgs(["select-represented", "EMISOR", "DE", "PRUEBA"]), {
    type: "select-represented",
    text: "EMISOR DE PRUEBA",
  });
  assert.deepEqual(parseSessionCommandArgs(["use-page", "1"]), { type: "use-page", index: 1 });
  assert.deepEqual(parseSessionCommandArgs(["prepare-invoice", "jobs/factura.json"]), {
    type: "prepare-invoice",
    jobPath: "jobs/factura.json",
  });
  assert.deepEqual(parseSessionCommandArgs(["emit-prepared-invoice", "00000000-0000-4000-8000-000000000000", "EMITIR"]), {
    type: "emit-prepared-invoice",
    preparedInvoiceId: "00000000-0000-4000-8000-000000000000",
    confirmation: "EMITIR",
  });
  assert.deepEqual(parseSessionCommandArgs(["revalidate-prepared-invoice", "00000000-0000-4000-8000-000000000000", "EMITIR"]), {
    type: "revalidate-prepared-invoice",
    preparedInvoiceId: "00000000-0000-4000-8000-000000000000",
    confirmation: "EMITIR",
  });
  assert.deepEqual(parseSessionCommandArgs(["save-print-pdf", "factura.pdf"]), {
    type: "save-print-pdf",
    outputPath: "factura.pdf",
  });
});

test("la sesión normal rechaza comandos genéricos mutantes y URLs arbitrarias", () => {
  for (const argv of [
    ["click-text", "Aceptar"],
    ["select-option", "0", "Anular"],
    ["fill-label", "Campo", "valor"],
    ["fill-input", "0", "valor"],
    ["press", "Tab"],
    ["check-text", "Confirmar"],
    ["save-url-pdf", "https://example.test/factura", "factura.pdf"],
  ]) {
    assert.throws(() => parseSessionCommandArgs(argv), /desconocido/);
  }
  assert.throws(
    () => parseSessionCommandArgs(["click-text", "Confirmar", "--confirm-risk"]),
    /ya no está permitido/,
  );
});

test("sessionCommandSchema valida la ruta preparada y rechaza payloads no permitidos", () => {
  assert.equal(sessionCommandSchema.parse({ type: "status" }).type, "status");
  assert.equal(sessionCommandSchema.parse({ type: "pages" }).type, "pages");
  assert.equal(sessionCommandSchema.parse({ type: "use-page", index: 1 }).type, "use-page");
  assert.equal(sessionCommandSchema.parse({ type: "inputs" }).type, "inputs");
  assert.equal(sessionCommandSchema.parse({ type: "resume-authentication" }).type, "resume-authentication");
  assert.equal(sessionCommandSchema.parse({ type: "prepare-invoice", jobPath: "jobs/factura.json" }).type, "prepare-invoice");
  assert.equal(sessionCommandSchema.parse({ type: "emit-prepared-invoice", preparedInvoiceId: "00000000-0000-4000-8000-000000000000", confirmation: "EMITIR" }).type, "emit-prepared-invoice");
  assert.equal(sessionCommandSchema.parse({ type: "revalidate-prepared-invoice", preparedInvoiceId: "00000000-0000-4000-8000-000000000000", confirmation: "EMITIR" }).type, "revalidate-prepared-invoice");
  assert.throws(() => sessionCommandSchema.parse({ type: "emit-prepared-invoice", preparedInvoiceId: "00000000-0000-4000-8000-000000000000", confirmation: "SI" }));
  assert.throws(() => sessionCommandSchema.parse({ type: "revalidate-prepared-invoice", preparedInvoiceId: "00000000-0000-4000-8000-000000000000", confirmation: "SI" }));
  assert.equal(sessionCommandSchema.parse({ type: "save-print-pdf", outputPath: "factura.pdf" }).type, "save-print-pdf");
  assert.equal(sessionCommandSchema.parse({ type: "select-options" }).type, "select-options");
  assert.throws(() => sessionCommandSchema.parse({ type: "click-text", text: "Aceptar" }));
  assert.throws(() => sessionCommandSchema.parse({ type: "save-url-pdf", url: "https://example.test/factura", outputPath: "factura.pdf" }));
  assert.throws(() => sessionCommandSchema.parse({ type: "open-service", serviceName: "" }));
});

test("la autorización local acepta solo tokens coincidentes", () => {
  assert.equal(isAuthorizedSessionRequest({}, "abc"), false);
  assert.equal(isAuthorizedSessionRequest({ authorization: "Bearer abc" }, "abc"), true);
  assert.equal(isAuthorizedSessionRequest({ "x-arca-session-token": "abc" }, "abc"), true);
  assert.equal(isAuthorizedSessionRequest({ authorization: "Bearer wrong" }, "abc"), false);
});

test("redactCommandForLog conserva únicamente comandos que no reciben secretos", () => {
  assert.deepEqual(redactCommandForLog({ type: "status" }), { type: "status" });
  assert.deepEqual(redactCommandForLog({ type: "select-represented", text: "Identidad fiscal ficticia" }), { type: "select-represented" });
  assert.deepEqual(redactCommandForLog({ type: "prepare-invoice", jobPath: "invoice-handle-ficticio.json" }), { type: "prepare-invoice" });
  assert.deepEqual(redactCommandForLog({ type: "revalidate-prepared-invoice", preparedInvoiceId: "00000000-0000-4000-8000-000000000000", confirmation: "EMITIR" }), { type: "revalidate-prepared-invoice" });
});

test("emit-prepared-invoice requiere confirmación exacta EMITIR", () => {
  assert.throws(() => parseSessionCommandArgs(["emit-prepared-invoice", "00000000-0000-4000-8000-000000000000", "emitir"]), /EMITIR/);
});

test("revalidate-prepared-invoice requiere confirmación exacta y una sesión visible habilitada explícitamente", () => {
  assert.throws(() => parseSessionCommandArgs(["revalidate-prepared-invoice", "00000000-0000-4000-8000-000000000000", "emitir"]), /EMITIR/);
  const command = parseSessionCommandArgs(["revalidate-prepared-invoice", "00000000-0000-4000-8000-000000000000", "EMITIR"]);
  assert.throws(() => assertCommandAllowedInSessionMode(command, { visibilityMode: "visible" }), /iniciada explícitamente/i);
  assert.doesNotThrow(() => assertCommandAllowedInSessionMode(command, {
    visibilityMode: "visible",
    revalidationCapability: "invoice-services-single-item",
  }));
  assert.throws(() => assertCommandAllowedInSessionMode(command, {
    visibilityMode: "production-hidden",
    learnedCapability: "invoice-services-single-item",
    revalidationCapability: "invoice-services-single-item",
    allowedCommands: ["revalidate-prepared-invoice"],
  }), /sesión visible/i);
});

test("una sesión de revalidación consumida solo admite lecturas y nunca una segunda preparación o emisión", () => {
  const policy = {
    visibilityMode: "visible" as const,
    revalidationCapability: "invoice-services-single-item" as const,
    revalidationConsumed: true,
  };
  assert.doesNotThrow(() => assertCommandAllowedInSessionMode(parseSessionCommandArgs(["status"]), policy));
  assert.throws(
    () => assertCommandAllowedInSessionMode(parseSessionCommandArgs(["prepare-invoice", "job.json"]), policy),
    /ya fue consumida/i,
  );
  assert.throws(
    () => assertCommandAllowedInSessionMode(parseSessionCommandArgs(["revalidate-prepared-invoice", "00000000-0000-4000-8000-000000000000", "EMITIR"]), policy),
    /ya fue consumida/i,
  );
});

test("production-hidden solo permite los comandos declarados por la capacidad", () => {
  assert.doesNotThrow(() => assertCommandAllowedInSessionMode(parseSessionCommandArgs(["status"]), {
    visibilityMode: "production-hidden",
    learnedCapability: "invoice-services-single-item",
    allowedCommands: ["status", "prepare-invoice", "emit-prepared-invoice"],
  }));
  assert.doesNotThrow(() => assertCommandAllowedInSessionMode(parseSessionCommandArgs(["prepare-invoice", "jobs/factura.json"]), {
    visibilityMode: "production-hidden",
    learnedCapability: "invoice-services-single-item",
    allowedCommands: ["status", "prepare-invoice", "emit-prepared-invoice"],
  }));
  assert.throws(() => assertCommandAllowedInSessionMode(parseSessionCommandArgs(["open-service", "Monotributo"]), {
    visibilityMode: "production-hidden",
    learnedCapability: "invoice-services-single-item",
    allowedCommands: ["status", "prepare-invoice", "emit-prepared-invoice"],
  }), /no esta permitido/);
  assert.throws(() => assertCommandAllowedInSessionMode(parseSessionCommandArgs(["resume-authentication"]), {
    visibilityMode: "production-hidden",
    learnedCapability: "invoice-services-single-item",
    allowedCommands: ["status", "prepare-invoice", "emit-prepared-invoice"],
  }), /no esta permitido/);
  assert.throws(() => assertCommandAllowedInSessionMode(parseSessionCommandArgs(["prepare-invoice", "jobs/factura.json"]), {
    visibilityMode: "production-hidden",
  }), /capacidad|manifiesto/);
});
