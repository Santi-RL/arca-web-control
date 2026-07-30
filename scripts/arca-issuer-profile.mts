import { resolveCredentialIdentity } from "../src/config/env.js";
import { loadIssuerProfile, removeIssuerRegime, saveIssuerRegime, specificRegimeCatalog, specificRegimeIds, SpecificRegimeId } from "../src/issuers/profile.js";
import { ensureRuntimeLayout } from "../src/config/runtimePaths.js";

const [operation, ...args] = process.argv.slice(2);
const runtime = await ensureRuntimeLayout();
const issuerSelector = valueAfter(args, "--issuer");
if (!issuerSelector) throw new Error("Falta --issuer <CUIT-o-nombre-único>.");
const identity = resolveCredentialIdentity(issuerSelector);

if (operation === "show") {
  const profile = await loadIssuerProfile(identity.cuit, runtime);
  console.log(JSON.stringify({ issuerCuit: profile.issuerCuit, issuerName: identity.displayName, specificRegimes: profile.specificRegimes }, null, 2));
} else if (operation === "set-regime") {
  const regime = requireRegime(valueAfter(args, "--regime"));
  const activity = valueAfter(args, "--activity");
  if (!activity) throw new Error("Falta --activity <código-de-seis-dígitos>.");
  const profile = await saveIssuerRegime(identity.cuit, regime, activity, runtime);
  console.log(JSON.stringify({ ok: true, issuerCuit: profile.issuerCuit, regime, title: specificRegimeCatalog[regime].title, activityCode: activity }, null, 2));
} else if (operation === "remove-regime") {
  const regime = requireRegime(valueAfter(args, "--regime"));
  if (!args.includes("ELIMINAR_REGIMEN")) throw new Error("La eliminación requiere ELIMINAR_REGIMEN.");
  await removeIssuerRegime(identity.cuit, regime, runtime);
  console.log(JSON.stringify({ ok: true, issuerCuit: identity.cuit, removed: regime }, null, 2));
} else {
  throw new Error("Uso: arca:issuer:profile -- show|set-regime|remove-regime --issuer <selector> [--regime <id>] [--activity <código>] [ELIMINAR_REGIMEN]");
}

function valueAfter(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}

function requireRegime(value: string | undefined): SpecificRegimeId {
  if (!value || !specificRegimeIds.includes(value as SpecificRegimeId)) {
    throw new Error(`Régimen inválido. Opciones: ${specificRegimeIds.join(", ")}.`);
  }
  return value as SpecificRegimeId;
}
