import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { emitInput, mcpToolNames, prepareChatInput } from "./contracts.js";

test("MCP no expone herramientas genéricas ni credenciales", () => {
  assert.equal(mcpToolNames.some((name) => /click|fill|credential|secret/i.test(name)), false);
  assert.equal(mcpToolNames.includes("arca_learn_resume_authentication"), true);
});

test("MCP exige EMITIR exacto", () => {
  const schema = z.object(emitInput);
  assert.equal(schema.safeParse({ preparedInvoiceId: "00000000-0000-4000-8000-000000000000", confirmation: "emitir" }).success, false);
  assert.equal(schema.safeParse({ preparedInvoiceId: "00000000-0000-4000-8000-000000000000", confirmation: "EMITIR" }).success, true);
});

test("MCP conversacional recibe datos fiscales pero nunca una clave", () => {
  const keys = Object.keys(prepareChatInput.shape);
  assert.equal(keys.includes("intentId"), true);
  assert.equal(keys.includes("issuerSelector"), true);
  assert.equal(keys.some((key) => /clave|password|secret/i.test(key)), false);
});

test("MCP discrimina receptor identificado y consumidor final anónimo", () => {
  const common = {
    intentId: "00000000-0000-4000-8000-000000000001",
    issuerSelector: "Emisor Ficticio",
    pointOfSale: 1,
    date: "15/06/2030",
    billingPeriodFrom: "01/06/2030",
    billingPeriodTo: "30/06/2030",
    saleCondition: "Transferencia bancaria",
    description: "Servicio ficticio",
    amount: "100000.00",
  };
  assert.equal(prepareChatInput.safeParse({
    ...common,
    recipientCuit: "20-00000000-1",
    recipientVatCondition: "IVA Responsable Inscripto",
  }).success, true);
  const anonymous = {
    ...common,
    recipientKind: "anonymous-final-consumer",
    recipientVatCondition: "Consumidor Final",
  };
  assert.equal(prepareChatInput.safeParse(anonymous).success, true);
  assert.equal(prepareChatInput.safeParse({ ...anonymous, recipientCuit: "20-00000000-1" }).success, false);
  assert.equal(prepareChatInput.safeParse({ ...anonymous, recipientName: "RECEPTOR FICTICIO" }).success, false);
  assert.equal(prepareChatInput.safeParse({ ...anonymous, recipientCommercialAddress: "DOMICILIO FICTICIO 123" }).success, false);
  assert.equal(prepareChatInput.safeParse({ ...anonymous, recipientVatCondition: "IVA Responsable Inscripto" }).success, false);
  assert.equal(prepareChatInput.safeParse({ ...common, recipientVatCondition: "Consumidor Final" }).success, false);
});
