const officialArcaAuthOrigins = new Set([
  "https://auth.afip.gob.ar",
  // El flujo preexistente ya contemplaba el hostname con la marca ARCA.
  // Se enumera de forma explícita para no abrir un wildcard de subdominios.
  "https://auth.arca.gob.ar",
]);

const officialArcaPortalOrigin = "https://portalcf.cloud.afip.gob.ar";
const officialArcaRcelOrigin = "https://fe.afip.gob.ar";
const officialArcaRcelPaths = new Set([
  "/rcel/jsp/index_bis.jsp",
  "/rcel/jsp/menu_ppal.jsp",
  "/rcel/jsp/buscarPtosVtas",
  "/rcel/jsp/buscarPtosVtas.do",
  "/rcel/jsp/genComDatosEmisor.do",
  "/rcel/jsp/genComDatosReceptor.do",
  "/rcel/jsp/genComDatosOperacion.do",
  "/rcel/jsp/genComResumenDatos.do",
]);

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function hasNoEmbeddedCredentials(url: URL): boolean {
  return url.username === "" && url.password === "";
}

function hasExactOrigin(url: URL, origin: string): boolean {
  return hasNoEmbeddedCredentials(url) && url.origin === origin;
}

function canonicalRcelPath(url: URL): string {
  return url.pathname.replace(/;jsessionid=[^/;?#]*/gi, "");
}

/**
 * La autenticación es el único tramo que recibe secretos. Por eso se usa una
 * allowlist de orígenes exactos, nunca coincidencias parciales sobre la URL.
 */
export function isOfficialArcaAuthUrl(value: string): boolean {
  const url = parseUrl(value);
  return Boolean(url && hasNoEmbeddedCredentials(url) && officialArcaAuthOrigins.has(url.origin));
}

export function assertOfficialArcaAuthUrl(value: string, action: string): void {
  if (!isOfficialArcaAuthUrl(value)) {
    throw new Error(`ARCA_UNTRUSTED_AUTH_ORIGIN: se detuvo ${action}; la página no pertenece a un origen HTTPS oficial de autenticación.`);
  }
}

export function isOfficialArcaPortalUrl(value: string): boolean {
  const url = parseUrl(value);
  if (!url || !hasExactOrigin(url, officialArcaPortalOrigin)) return false;
  return /^\/portal\/app\/?$/.test(url.pathname);
}

export function isOfficialArcaPortalOriginUrl(value: string): boolean {
  const url = parseUrl(value);
  return Boolean(url && hasExactOrigin(url, officialArcaPortalOrigin));
}

export function assertOfficialArcaPortalUrl(value: string, action: string): void {
  if (!isOfficialArcaPortalUrl(value)) {
    throw new Error(`ARCA_UNTRUSTED_PORTAL_ORIGIN: se detuvo ${action}; la página no coincide con el Portal de Clave Fiscal oficial.`);
  }
}

export function isOfficialArcaRcelOriginUrl(value: string): boolean {
  const url = parseUrl(value);
  return Boolean(url && hasExactOrigin(url, officialArcaRcelOrigin));
}

export function isOfficialArcaRcelUrl(value: string): boolean {
  const url = parseUrl(value);
  return Boolean(url && hasExactOrigin(url, officialArcaRcelOrigin) && officialArcaRcelPaths.has(canonicalRcelPath(url)));
}

export function assertOfficialArcaRcelUrl(value: string, action: string): void {
  if (!isOfficialArcaRcelUrl(value)) {
    throw new Error(`ARCA_UNTRUSTED_RCEL_PAGE: se detuvo ${action}; la página no coincide con un origen y una ruta RCEL aprobados.`);
  }
}

/**
 * Superficie que una sesión operativa puede leer o adoptar. RCEL permanece
 * limitado a rutas aprendidas; autenticación y Portal se limitan a sus
 * orígenes HTTPS exactos para contemplar login, redirecciones y expiración.
 */
export function isOfficialArcaInspectableUrl(value: string): boolean {
  return isOfficialArcaAuthUrl(value)
    || isOfficialArcaPortalOriginUrl(value)
    || isOfficialArcaRcelUrl(value);
}

export function assertOfficialArcaInspectableUrl(value: string, action: string): void {
  if (!isOfficialArcaInspectableUrl(value)) {
    throw new Error(`ARCA_UNTRUSTED_INSPECTION_PAGE: se detuvo ${action}; la pestaña no pertenece a una superficie oficial permitida de ARCA.`);
  }
}

export function isOfficialArcaLegacyPrintUrl(value: string): boolean {
  const url = parseUrl(value);
  if (!url || !hasExactOrigin(url, officialArcaRcelOrigin)) return false;
  return /^https:\/\/fe\.afip\.gob\.ar\/rcel\/jsp\/imprimirComprobante\.do\?c=\d+$/.test(url.href);
}

export function assertOfficialArcaLegacyPrintUrl(value: string): void {
  if (!isOfficialArcaLegacyPrintUrl(value)) {
    throw new Error("ARCA_UNTRUSTED_PRINT_URL: se rechazó una URL de impresión que no coincide exactamente con el endpoint oficial permitido.");
  }
}

export function isOfficialArcaGeneratedInvoicePageUrl(value: string): boolean {
  const url = parseUrl(value);
  if (!url || !hasExactOrigin(url, officialArcaRcelOrigin)) return false;
  return url.href === "https://fe.afip.gob.ar/rcel/jsp/genComResumenDatos.do";
}

export function sanitizeArcaUrlForOutput(value: string): string {
  if (value === "about:blank") return value;
  const url = parseUrl(value);
  if (!url) return "[url-no-válida]";
  if (url.protocol !== "https:") return "[url-no-confiable]";
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/(?:;|%3b)[^/]*/gi, "");
  return url.toString();
}

export function assertOfficialArcaGeneratedInvoicePageUrl(value: string): void {
  if (!isOfficialArcaGeneratedInvoicePageUrl(value)) {
    throw new Error("ARCA_UNTRUSTED_GENERATED_INVOICE_PAGE: la página actual no coincide exactamente con la pantalla oficial de comprobante generado.");
  }
}
