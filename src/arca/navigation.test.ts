import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Page } from "playwright";
import { openComprobantesEnLinea, selectRepresentedIssuer, waitForComprobantesPage } from "./navigation.js";

const strictContext = {
  strictSelectors: true,
  interactive: false,
  manualIntervention: false,
} as const;

test("abre el resultado del buscador y no el mosaico global de Más utilizados", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await portalFixture(page, 1);

    const servicePage = await openComprobantesEnLinea(page, strictContext);

    assert.equal(await page.evaluate(() => document.body.dataset.clicked), "search-result");
    assert.equal(await servicePage.title(), "RCEL");
  } finally {
    await browser.close();
  }
});

test("dos resultados válidos del buscador detienen el flujo por ambigüedad", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await portalFixture(page, 2);

    await assert.rejects(
      () => openComprobantesEnLinea(page, strictContext),
      /Selector ambiguo.*resultado del buscador Comprobantes en Linea/i,
    );
    assert.equal(await page.evaluate(() => document.body.dataset.clicked ?? ""), "");
  } finally {
    await browser.close();
  }
});

test("no adopta una pestaña con título RCEL si el origen es engañoso", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await context.route("https://portalcf.cloud.afip.gob.ar/portal/app/", (route) => route.fulfill({ contentType: "text/html", body: "<title>Portal</title>" }));
    await context.route("https://ejemplo.invalid/forged", (route) => route.fulfill({ contentType: "text/html", body: "<title>RCEL - Comprobantes en Línea</title><main>Generar Comprobantes</main>" }));
    await page.goto("https://portalcf.cloud.afip.gob.ar/portal/app/");
    const pagesBefore = new Set([page]);
    const forged = await context.newPage();
    await forged.goto("https://ejemplo.invalid/forged");

    await assert.rejects(() => waitForComprobantesPage(page, pagesBefore, 150), /No se pudo detectar la pestana/i);
  } finally {
    await browser.close();
  }
});

test("prioriza el CUIT exacto sobre una etiqueta de nombre que podría corresponder a otra persona", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const body = `
      <h1 id="selector-heading">Seleccione la empresa a representar</h1>
      <button id="wrong">EMISOR DUPLICADO</button>
      <button id="target">20-00000000-1 - EMISOR CANÓNICO</button>
      <button id="continue">Continuar</button>
      <script>
        document.querySelector('#wrong').addEventListener('click', () => {
          document.body.dataset.issuerClicked = 'wrong';
        });
        document.querySelector('#target').addEventListener('click', () => {
          document.body.dataset.issuerClicked = 'target';
        });
        document.querySelector('#continue').addEventListener('click', () => {
          document.body.dataset.continued = 'yes';
          document.querySelector('#selector-heading')?.remove();
        });
      </script>
    `;
    await page.context().route("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp", (route) => route.fulfill({ contentType: "text/html", body }));
    await page.goto("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");

    await selectRepresentedIssuer(page, "20000000001", "EMISOR DUPLICADO", strictContext);

    assert.equal(await page.evaluate(() => document.body.dataset.issuerClicked), "target");
    assert.equal(await page.evaluate(() => document.body.dataset.continued), "yes");
  } finally {
    await browser.close();
  }
});

test("selecciona el input exacto aunque ARCA muestre apellido y nombre en orden inverso", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const body = `
      <h1 id="selector-heading">Seleccione la empresa a representar</h1>
      <p>Usuario: 20-00000000-1 - NOMBRE FICTICIO</p>
      <input id="target" type="submit" value="FICTICIO NOMBRE">
      <script>
        document.querySelector('#target').addEventListener('click', (event) => {
          event.preventDefault();
          document.body.dataset.clicked = 'target';
          document.querySelector('#selector-heading')?.remove();
        });
      </script>
    `;
    await page.context().route("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp", (route) => route.fulfill({ contentType: "text/html", body }));
    await page.goto("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");

    await selectRepresentedIssuer(page, "20000000001", "Nombre Ficticio", strictContext);

    assert.equal(await page.evaluate(() => document.body.dataset.clicked), "target");
  } finally {
    await browser.close();
  }
});

test("dos controles con las mismas palabras del nombre detienen el selector por ambigüedad", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const body = `
      <h1>Seleccione la empresa a representar</h1>
      <input type="submit" value="FICTICIO NOMBRE">
      <input type="submit" value="NOMBRE FICTICIO">
    `;
    await page.context().route("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp", (route) => route.fulfill({ contentType: "text/html", body }));
    await page.goto("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp");

    await assert.rejects(
      () => selectRepresentedIssuer(page, "20000000001", "Nombre Ficticio", strictContext),
      /Selector ambiguo.*emisor\/representado/i,
    );
  } finally {
    await browser.close();
  }
});

async function portalFixture(page: Page, resultCount: number): Promise<void> {
  const results = Array.from({ length: resultCount }, (_, index) => `
    <a class="service-result" href="#resultado-${index + 1}">
      <span>Comprobantes en línea</span>
      <span>Sistema de emisión de comprobantes electrónicos</span>
    </a>
  `).join("");

  const portalHtml = `
    <label>Buscar trámites y servicios <input type="search" placeholder="¿Qué necesitás? Buscá trámites y servicios"></label>
    <section aria-label="Más utilizados">
      <a id="recent-service" href="#reciente">Comprobantes en línea</a>
    </section>
    <section class="search-results" aria-label="Resultados del buscador">
      ${results}
    </section>
    <script>
      const openRcel = (source) => {
        document.body.dataset.clicked = source;
        window.open('https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp', '_blank');
      };
      document.querySelector('#recent-service').addEventListener('click', (event) => {
        event.preventDefault();
        openRcel('most-used');
      });
      for (const result of document.querySelectorAll('.service-result')) {
        result.addEventListener('click', (event) => {
          event.preventDefault();
          openRcel('search-result');
        });
      }
    </script>
  `;
  const utf8Html = { "content-type": "text/html; charset=utf-8" };
  await page.context().route("https://portalcf.cloud.afip.gob.ar/portal/app/", (route) => route.fulfill({ headers: utf8Html, body: portalHtml }));
  await page.context().route("https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp", (route) => route.fulfill({ headers: utf8Html, body: "<title>RCEL</title><main>Generar Comprobantes</main>" }));
  await page.goto("https://portalcf.cloud.afip.gob.ar/portal/app/");
}
