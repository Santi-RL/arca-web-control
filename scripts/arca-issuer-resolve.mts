import { formatCredentialCuit } from "../src/config/credentialIdentity.js";
import { lookupConfiguredCredentialIdentity } from "../src/config/credentialProvider.js";
import { getRuntimePaths } from "../src/config/runtimePaths.js";

const startedAt = performance.now();
const selector = valueAfter(process.argv.slice(2), "--issuer");
if (!selector) throw new Error("Uso: arca:issuer:resolve -- --issuer <CUIT-o-nombre>.");

const lookup = lookupConfiguredCredentialIdentity(getRuntimePaths(), selector);
const elapsedMs = Math.round(performance.now() - startedAt);
if (lookup.status === "resolved") {
  console.log(JSON.stringify({
    ok: true,
    status: lookup.status,
    issuer: publicIdentity(lookup.identity),
    lookupMs: elapsedMs,
  }, null, 2));
} else {
  const message = lookup.status === "needs_confirmation"
    ? "No hubo una coincidencia exacta. Confirmá uno de los emisores sugeridos o indicá el CUIT."
    : lookup.status === "ambiguous"
      ? "El nombre exacto corresponde a más de un CUIT. Elegí uno explícitamente."
      : lookup.status === "invalid_cuit"
        ? "El selector numérico no contiene un CUIT válido."
        : "No existe un emisor coincidente en el índice configurado.";
  console.log(JSON.stringify({
    ok: false,
    status: lookup.status,
    message,
    candidates: lookup.candidates.map(publicIdentity),
    lookupMs: elapsedMs,
  }, null, 2));
  process.exitCode = 2;
}

function publicIdentity(identity: { displayName: string; cuit: string }): { name: string; cuit: string } {
  return { name: identity.displayName, cuit: formatCredentialCuit(identity.cuit) };
}

function valueAfter(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}
