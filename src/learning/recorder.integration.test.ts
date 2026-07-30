import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { LearningRecorder } from "./recorder.js";

test("el control híbrido inspecciona y actúa sin registrar valores ni password", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-learning-"));
  try {
    const html = `
      <input id="dato" name="dato">
      <input id="clave" name="clave" type="password">
      <select id="tipo"><option>seleccionar...</option><option>Factura C</option></select>
      <label><input type="checkbox">Transferencia Bancaria</label>
      <button id="seguir" value="SERVER-PRIVATE-ID" onclick="window.clicked=true">Continuar</button>
      <button id="confirmar" onclick="window.confirmed=true">Confirmar Datos</button>
      <button id="sin-nombre" onclick="window.iconClicked=true"><svg></svg></button>
      <button id="menu" type="button" aria-label="Menu Principal" onclick="window.menuClicked=true">Menú Principal</button>
      <form id="riesgoso" onsubmit="window.submitted=true"><button type="submit">Guardar</button></form>
    `;
    await context.route("https://fe.afip.gob.ar/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    await page.goto("https://fe.afip.gob.ar/rcel/jsp/genComDatosReceptor.do");
    const recorder = new LearningRecorder(page, directory);
    await recorder.start();
    let inspection = await recorder.inspect();
    assert.equal(inspection.inputs.length, 1);
    assert.equal(inspection.inputs[0]?.id, "dato");
    assert.equal(inspection.actions.find((action) => action.tag === "button")?.name, "Continuar");
    assert.doesNotMatch(JSON.stringify(inspection), /SERVER-PRIVATE-ID/);
    await page.evaluate(() => document.body.setAttribute("data-dom-change", "1"));
    await assert.rejects(() => recorder.fillInput(inspection.inspectionId, 0, "NO-DEBE-APLICARSE"), /cambiaron desde inspect/);
    inspection = await recorder.inspect();
    await page.locator("#dato").evaluate((input) => { (input as HTMLInputElement).value = "CAMBIO-SIN-MUTACION-DOM"; });
    await assert.rejects(() => recorder.fillInput(inspection.inspectionId, 0, "NO-DEBE-APLICARSE"), /cambiaron desde inspect/);
    inspection = await recorder.inspect();
    await recorder.fillInput(inspection.inspectionId, 0, "VALOR-PRIVADO");
    await assert.rejects(() => recorder.fillInput(inspection.inspectionId, 0, "NO-DEBE-APLICARSE"), /ya fue utilizada/);
    inspection = await recorder.inspect();
    await recorder.selectExact(inspection.inspectionId, 0, "Factura C");
    inspection = await recorder.inspect();
    await recorder.checkExact(inspection.inspectionId, "Transferencia Bancaria");
    inspection = await recorder.inspect();
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<div id="captcha">captcha</div>'));
    await assert.rejects(() => recorder.fillInput(inspection.inspectionId, 0, "NO-DEBE-APLICARSE"), /captcha/i);
    await page.locator("#captcha").evaluate((element) => element.remove());
    await context.route("https://example.invalid/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: '<button id="externo-frame">Contenido de iframe externo</button>' }));
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<iframe src="https://example.invalid/frame"></iframe>'));
    await page.frameLocator("iframe").locator("#externo-frame").click();
    const secondPage = await context.newPage();
    await secondPage.goto("https://fe.afip.gob.ar/rcel/jsp/genComDatosEmisor.do");
    await assert.rejects(() => recorder.inspect(), /pestañas abiertas/);
    inspection = await recorder.inspect(1);
    await recorder.clickExact(inspection.inspectionId, "Continuar");
    await secondPage.close();
    const externalPage = await context.newPage();
    await externalPage.setContent('<button id="externo">Contenido externo privado</button>');
    await externalPage.locator("#externo").click();
    inspection = await recorder.inspect();
    assert.equal(inspection.url, "https://fe.afip.gob.ar/rcel/jsp/genComDatosReceptor.do");
    await externalPage.close();
    inspection = await recorder.inspect();
    await recorder.clickExact(inspection.inspectionId, "Continuar");
    inspection = await recorder.inspect();
    await page.reload();
    await assert.rejects(() => recorder.clickExact(inspection.inspectionId, "Continuar"), /cambiaron desde inspect/);
    inspection = await recorder.inspect();
    await recorder.clickExact(inspection.inspectionId, "Continuar");
    await page.getByRole("button", { name: "Confirmar Datos" }).click();
    await page.locator("#riesgoso").evaluate((form) => (form as HTMLFormElement).requestSubmit());
    await page.locator("#riesgoso").evaluate((form) => (form as HTMLFormElement).submit());
    await recorder.finish({ capability: "test", intent: "test", issuerKey: "20000000001" });
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { clicked?: boolean }).clicked)), true);
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { confirmed?: boolean }).confirmed)), false);
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { submitted?: boolean }).submitted)), false);
    await page.goto("https://fe.afip.gob.ar/rcel/jsp/genComResumenDatos.do");
    await page.locator("#seguir").click();
    await page.locator("#sin-nombre").click();
    await page.locator("#menu").click();
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { clicked?: boolean }).clicked)), false);
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { iconClicked?: boolean }).iconClicked)), false);
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { menuClicked?: boolean }).menuClicked)), true);
    const events = await fs.readFile(path.join(directory, "events.jsonl"), "utf8");
    assert.doesNotMatch(events, /VALOR-PRIVADO/);
    assert.doesNotMatch(events, /SERVER-PRIVATE-ID/);
    assert.doesNotMatch(events, /Contenido externo privado/);
    assert.doesNotMatch(events, /Contenido de iframe externo/);
    assert.match(events, /blocked_irreversible/);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("click-exact no puede accionar controles que quedaron fuera de la inspección", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-learning-limit-"));
  try {
    const buttons = Array.from({ length: 99 }, (_, index) => `<button>Acción ${index}</button>`).join("");
    const longName = "L".repeat(350);
    await context.route("https://fe.afip.gob.ar/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: `${buttons}<button id="largo" onclick="window.longClicked=true">${longName}</button><button id="fuera" onclick="window.outsideClicked=true">Fuera de inspección</button>` }));
    await page.goto("https://fe.afip.gob.ar/rcel/jsp/genComDatosReceptor.do");
    const recorder = new LearningRecorder(page, directory);
    await recorder.start();
    let inspection = await recorder.inspect();
    assert.equal(inspection.actions.length, 100);
    assert.equal(inspection.actions.some((action) => action.name === "Fuera de inspección"), false);
    const inspectedLongName = inspection.actions.find((action) => action.name.startsWith("L"))?.name;
    assert.equal(inspectedLongName?.length, 300);
    await recorder.clickExact(inspection.inspectionId, inspectedLongName as string);
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { longClicked?: boolean }).longClicked)), true);
    inspection = await recorder.inspect();
    await assert.rejects(() => recorder.clickExact(inspection.inspectionId, "Fuera de inspección"), /se encontraron 0/);
    assert.equal(await page.evaluate(() => Boolean((window as unknown as { outsideClicked?: boolean }).outsideClicked)), false);
  } finally {
    await context.close();
    await browser.close();
  }
});
