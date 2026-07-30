import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { executeControlledEmission } from "./emission.js";

test("señala el primer intento de clic después de completar las reservas durables", async () => {
  const events: string[] = [];
  let page: Page;
  const locator = {
    page: () => page,
    or: () => locator,
    count: async () => 1,
    nth: () => locator,
    isVisible: async () => true,
    click: async () => { events.push("click"); throw new Error("fin controlado"); },
  };
  page = {
    url: () => "https://fe.afip.gob.ar/rcel/jsp/genComResumenDatos.do",
    getByRole: () => locator,
  } as unknown as Page;

  await assert.rejects(() => executeControlledEmission(page, {
    onIrreversible: async () => { events.push("reservation"); },
    onFirstClick: () => { events.push("first-click"); },
  }), /fin controlado/);
  assert.deepEqual(events, ["reservation", "first-click", "click"]);
});
