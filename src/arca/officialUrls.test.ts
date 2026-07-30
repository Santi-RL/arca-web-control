import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOfficialArcaAuthUrl,
  assertOfficialArcaGeneratedInvoicePageUrl,
  assertOfficialArcaInspectableUrl,
  assertOfficialArcaLegacyPrintUrl,
  assertOfficialArcaPortalUrl,
  assertOfficialArcaRcelUrl,
  isOfficialArcaAuthUrl,
  isOfficialArcaGeneratedInvoicePageUrl,
  isOfficialArcaInspectableUrl,
  isOfficialArcaLegacyPrintUrl,
  isOfficialArcaPortalOriginUrl,
  isOfficialArcaPortalUrl,
  isOfficialArcaRcelOriginUrl,
  isOfficialArcaRcelUrl,
  sanitizeArcaUrlForOutput,
} from "./officialUrls.js";

test("la inspección de sesión solo admite superficies oficiales y rutas RCEL aprendidas", () => {
  assert.equal(isOfficialArcaInspectableUrl("https://auth.afip.gob.ar/contribuyente_/login.xhtml"), true);
  assert.equal(isOfficialArcaInspectableUrl("https://portalcf.cloud.afip.gob.ar/portal/app/expiredSession"), true);
  assert.equal(isOfficialArcaInspectableUrl("https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp"), true);
  assert.equal(isOfficialArcaInspectableUrl("https://fe.afip.gob.ar/rcel/jsp/pantalla-no-aprendida.do"), false);
  assert.equal(isOfficialArcaInspectableUrl("https://correo.ejemplo.invalid/bandeja"), false);
  assert.throws(
    () => assertOfficialArcaInspectableUrl("https://correo.ejemplo.invalid/bandeja?token=ficticio", "la captura"),
    (error: unknown) => error instanceof Error
      && /ARCA_UNTRUSTED_INSPECTION_PAGE/.test(error.message)
      && !error.message.includes("token="),
  );
});

test("acepta únicamente los orígenes HTTPS oficiales de autenticación", () => {
  assert.equal(isOfficialArcaAuthUrl("https://auth.afip.gob.ar/contribuyente_/login.xhtml"), true);
  assert.equal(isOfficialArcaAuthUrl("https://auth.arca.gob.ar/contribuyente_/login.xhtml?action=SYSTEM"), true);
  assert.equal(isOfficialArcaAuthUrl("https://AUTH.AFIP.GOB.AR/contribuyente_/login.xhtml"), true);
});

test("rechaza esquemas, puertos y hostnames de autenticación engañosos", () => {
  const atSign = String.fromCharCode(64);
  const rejected = [
    "http://auth.afip.gob.ar/contribuyente_/login.xhtml",
    "https://auth.afip.gob.ar:8443/contribuyente_/login.xhtml",
    "https://auth.afip.gob.ar.ejemplo.invalid/contribuyente_/login.xhtml",
    `https://auth.afip.gob.ar${atSign}ejemplo.invalid/contribuyente_/login.xhtml`,
    `https://user:placeholder${atSign}auth.afip.gob.ar/contribuyente_/login.xhtml`,
    "https://ejemplo.invalid/?next=https://auth.afip.gob.ar/contribuyente_/login.xhtml",
    "javascript:https://auth.afip.gob.ar/contribuyente_/login.xhtml",
    "no-es-una-url",
  ];

  for (const value of rejected) assert.equal(isOfficialArcaAuthUrl(value), false, value);
});

test("el error de origen no refleja una URL potencialmente sensible", () => {
  const deceptive = "https://ejemplo.invalid/?dato_reservado=valor-ficticio&next=https://auth.afip.gob.ar";
  assert.throws(
    () => assertOfficialArcaAuthUrl(deceptive, "el ingreso de la clave fiscal"),
    (error: unknown) => error instanceof Error
      && /ARCA_UNTRUSTED_AUTH_ORIGIN/.test(error.message)
      && !error.message.includes("dato_reservado=")
      && !error.message.includes("valor-ficticio"),
  );
});

test("reconoce el Portal de Clave Fiscal por origen y ruta exactos", () => {
  assert.equal(isOfficialArcaPortalUrl("https://portalcf.cloud.afip.gob.ar/portal/app/"), true);
  assert.equal(isOfficialArcaPortalUrl("https://portalcf.cloud.afip.gob.ar/portal/app?origen=login"), true);

  const atSign = String.fromCharCode(64);
  const rejected = [
    "http://portalcf.cloud.afip.gob.ar/portal/app/",
    "https://portalcf.cloud.afip.gob.ar.ejemplo.invalid/portal/app/",
    "https://ejemplo.invalid/?next=https://portalcf.cloud.afip.gob.ar/portal/app/",
    "https://portalcf.cloud.afip.gob.ar/portal/application",
    `https://usuario${atSign}portalcf.cloud.afip.gob.ar/portal/app/`,
  ];

  for (const value of rejected) assert.equal(isOfficialArcaPortalUrl(value), false, value);
  assert.throws(() => assertOfficialArcaPortalUrl(rejected[1]!, "la búsqueda de servicios"), /ARCA_UNTRUSTED_PORTAL_ORIGIN/);
});

test("las allowlists de origen rechazan userinfo, puertos alternativos y queries engañosas", () => {
  const atSign = String.fromCharCode(64);
  assert.equal(isOfficialArcaPortalOriginUrl("https://portalcf.cloud.afip.gob.ar/cualquier-ruta"), true);
  assert.equal(isOfficialArcaRcelOriginUrl("https://fe.afip.gob.ar/nueva-ruta-de-aprendizaje"), true);

  const rejectedPortal = [
    "https://portalcf.cloud.afip.gob.ar:8443/portal/app/",
    `https://user${atSign}portalcf.cloud.afip.gob.ar/portal/app/`,
    "https://portalcf.cloud.afip.gob.ar.ejemplo.invalid/portal/app/",
    "https://ejemplo.invalid/?next=https://portalcf.cloud.afip.gob.ar/portal/app/",
  ];
  for (const value of rejectedPortal) assert.equal(isOfficialArcaPortalOriginUrl(value), false, value);

  const rejectedRcel = [
    "https://fe.afip.gob.ar:8443/rcel/jsp/menu_ppal.jsp",
    `https://user${atSign}fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp`,
    "https://fe.afip.gob.ar.ejemplo.invalid/rcel/jsp/menu_ppal.jsp",
    "https://ejemplo.invalid/?next=https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp",
  ];
  for (const value of rejectedRcel) assert.equal(isOfficialArcaRcelOriginUrl(value), false, value);
});

test("RCEL admite solo las rutas fiscales observadas", () => {
  const allowedPaths = [
    "index_bis.jsp",
    "menu_ppal.jsp",
    "buscarPtosVtas",
    "buscarPtosVtas.do",
    "genComDatosEmisor.do",
    "genComDatosReceptor.do",
    "genComDatosOperacion.do",
    "genComResumenDatos.do",
  ];
  for (const path of allowedPaths) {
    assert.equal(isOfficialArcaRcelUrl(`https://fe.afip.gob.ar/rcel/jsp/${path}`), true, path);
  }
  assert.equal(isOfficialArcaRcelUrl("https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp;jsessionid=SESSION_MARKER"), true);

  const rejected = [
    "http://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp",
    "https://fe.afip.gob.ar:8443/rcel/jsp/menu_ppal.jsp",
    "https://fe.afip.gob.ar.ejemplo.invalid/rcel/jsp/menu_ppal.jsp",
    "https://ejemplo.invalid/?next=https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp",
    "https://fe.afip.gob.ar/rcel/jsp/menu_ppal.jsp/extra",
    "https://fe.afip.gob.ar/rcel/jsp/pantalla-no-aprendida.do",
  ];
  for (const value of rejected) assert.equal(isOfficialArcaRcelUrl(value), false, value);
  assert.throws(() => assertOfficialArcaRcelUrl(rejected[2]!, "la lectura fiscal"), /ARCA_UNTRUSTED_RCEL_PAGE/);
});

test("acepta únicamente la URL histórica exacta de impresión RCEL", () => {
  assert.equal(isOfficialArcaLegacyPrintUrl("https://fe.afip.gob.ar/rcel/jsp/imprimirComprobante.do?c=123456789"), true);

  const atSign = String.fromCharCode(64);
  const rejected = [
    "http://fe.afip.gob.ar/rcel/jsp/imprimirComprobante.do?c=123456789",
    "https://fe.afip.gob.ar:8443/rcel/jsp/imprimirComprobante.do?c=123456789",
    "https://fe.afip.gob.ar.ejemplo.invalid/rcel/jsp/imprimirComprobante.do?c=123456789",
    `https://user${atSign}fe.afip.gob.ar/rcel/jsp/imprimirComprobante.do?c=123456789`,
    "https://ejemplo.invalid/?next=https://fe.afip.gob.ar/rcel/jsp/imprimirComprobante.do?c=123456789",
    "https://fe.afip.gob.ar/rcel/jsp/imprimirComprobante.do",
    "https://fe.afip.gob.ar/rcel/jsp/imprimirComprobante.do?c=abc",
    "https://fe.afip.gob.ar/rcel/jsp/imprimirComprobante.do?c=123&otro=1",
    "https://fe.afip.gob.ar/rcel/jsp/imprimirComprobante.do?c=123&c=456",
    "https://fe.afip.gob.ar/rcel/jsp/imprimirComprobante.do?c=123#fragmento",
    "https://fe.afip.gob.ar/rcel/jsp/imprimirComprobante.do?c=123#",
    "https://fe.afip.gob.ar/rcel/jsp/imprimirComprobante.do/extra?c=123",
    "https://fe.afip.gob.ar/rcel/jsp/IMPRIMIRCOMPROBANTE.do?c=123",
  ];

  for (const value of rejected) assert.equal(isOfficialArcaLegacyPrintUrl(value), false, value);
});

test("el rechazo de impresión no refleja la URL recibida", () => {
  assert.throws(
    () => assertOfficialArcaLegacyPrintUrl("https://ejemplo.invalid/?dato_reservado=valor-ficticio"),
    (error: unknown) => error instanceof Error
      && /ARCA_UNTRUSTED_PRINT_URL/.test(error.message)
      && !error.message.includes("dato_reservado="),
  );
});

test("reconoce únicamente la pantalla oficial exacta de comprobante generado", () => {
  assert.equal(isOfficialArcaGeneratedInvoicePageUrl("https://fe.afip.gob.ar/rcel/jsp/genComResumenDatos.do"), true);

  const atSign = String.fromCharCode(64);
  const rejected = [
    "http://fe.afip.gob.ar/rcel/jsp/genComResumenDatos.do",
    "https://fe.afip.gob.ar:8443/rcel/jsp/genComResumenDatos.do",
    "https://fe.afip.gob.ar.ejemplo.invalid/rcel/jsp/genComResumenDatos.do",
    `https://user${atSign}fe.afip.gob.ar/rcel/jsp/genComResumenDatos.do`,
    "https://ejemplo.invalid/?next=https://fe.afip.gob.ar/rcel/jsp/genComResumenDatos.do",
    "https://fe.afip.gob.ar/rcel/jsp/genComResumenDatos.do?c=123",
    "https://fe.afip.gob.ar/rcel/jsp/genComResumenDatos.do?",
    "https://fe.afip.gob.ar/rcel/jsp/genComResumenDatos.do#fragmento",
    "https://fe.afip.gob.ar/rcel/jsp/genComResumenDatos.do#",
    "https://fe.afip.gob.ar/rcel/jsp/genComResumenDatos.do/extra",
    "https://fe.afip.gob.ar/rcel/jsp/GENCOMRESUMENDATOS.do",
  ];

  for (const value of rejected) assert.equal(isOfficialArcaGeneratedInvoicePageUrl(value), false, value);
});

test("el rechazo de la página generada no refleja la URL recibida", () => {
  assert.throws(
    () => assertOfficialArcaGeneratedInvoicePageUrl("https://ejemplo.invalid/?dato_reservado=valor-ficticio"),
    (error: unknown) => error instanceof Error
      && /ARCA_UNTRUSTED_GENERATED_INVOICE_PAGE/.test(error.message)
      && !error.message.includes("dato_reservado="),
  );
});

test("sanea URLs antes de mostrarlas o registrarlas", () => {
  const atSign = String.fromCharCode(64);
  const raw = `https://usuario:secreto${atSign}fe.afip.gob.ar/rcel;jsessionid=TOKEN/jsp/menu.do?token=reservado#fragmento`;
  const sanitized = sanitizeArcaUrlForOutput(raw);
  assert.equal(sanitized, "https://fe.afip.gob.ar/rcel/jsp/menu.do");
  assert.equal(sanitized.includes("usuario"), false);
  assert.equal(sanitized.includes("secreto"), false);
  assert.equal(sanitized.includes("TOKEN"), false);
  assert.equal(sanitized.includes("reservado"), false);
  assert.equal(sanitizeArcaUrlForOutput("about:blank"), "about:blank");
  assert.equal(sanitizeArcaUrlForOutput("no-es-una-url"), "[url-no-válida]");
  assert.equal(sanitizeArcaUrlForOutput("data:text/plain,dato-reservado"), "[url-no-confiable]");
  assert.equal(sanitizeArcaUrlForOutput("javascript:datoReservado()"), "[url-no-confiable]");
  assert.equal(
    sanitizeArcaUrlForOutput("https://fe.afip.gob.ar/rcel%3Bjsessionid=TOKEN/jsp/menu.do"),
    "https://fe.afip.gob.ar/rcel/jsp/menu.do",
  );
});
