import assert from "node:assert/strict";
import test from "node:test";
import { lookupCredentialIdentity, type CredentialIdentityMetadata } from "./credentialIdentity.js";

const syntheticPerson = identity("20000000001", "Valentina Quiroga");

test("resuelve por nombre exacto normalizado o CUIT sin cargar secretos", () => {
  assert.deepEqual(lookupCredentialIdentity([syntheticPerson], "  VALENTÍNA,   QUIROGA "), {
    status: "resolved",
    identity: syntheticPerson,
  });
  assert.deepEqual(lookupCredentialIdentity([syntheticPerson], "20-00000000-1"), {
    status: "resolved",
    identity: syntheticPerson,
  });
});

test("un único typo largo propone el emisor pero nunca lo resuelve automáticamente", () => {
  const sentinel = ["valor", "centinela", "no-real"].join("-");
  const withSentinel = { ...syntheticPerson, clave: sentinel };
  const lookup = lookupCredentialIdentity([withSentinel], "Valentina Quirog");

  assert.equal(lookup.status, "needs_confirmation");
  assert.deepEqual(lookup.status === "needs_confirmation" ? lookup.candidates : [], [syntheticPerson]);
  assert.doesNotMatch(JSON.stringify(lookup), new RegExp(sentinel));
});

test("un orden invertido solo se ofrece como sugerencia", () => {
  const lookup = lookupCredentialIdentity([syntheticPerson], "Quiroga Valentina");
  assert.equal(lookup.status, "needs_confirmation");
});

test("un segundo nombre omitido y un typo siguen siendo solo una sugerencia", () => {
  const registered = identity("20000000001", "Valentina Marcela Quiroga");
  const corrected = lookupCredentialIdentity([registered], "Quiroga Valentina");
  const withTypo = lookupCredentialIdentity([registered], "Quirog Valentina");
  assert.deepEqual(corrected, { status: "needs_confirmation", candidates: [registered] });
  assert.deepEqual(withTypo, { status: "needs_confirmation", candidates: [registered] });
});

test("una coincidencia exacta con dos CUIT queda ambigua y muestra ambos metadatos", () => {
  const lookup = lookupCredentialIdentity([
    syntheticPerson,
    identity("27000000006", "Valentina Quiroga"),
  ], "Valentina Quiroga");
  assert.equal(lookup.status, "ambiguous");
  assert.deepEqual(lookup.status === "ambiguous" ? lookup.candidates.map(({ cuit }) => cuit) : [], [
    "20000000001",
    "27000000006",
  ]);
});

test("no propone cambios de forma societaria, palabras faltantes ni CUIT inválidos", () => {
  const company = identity("27000000006", "EMPRESA TOTALMENTE FICTICIA SRL");
  assert.deepEqual(lookupCredentialIdentity([company], "EMPRESA TOTALMENTE FICTICIA SA"), { status: "not_found", candidates: [] });
  assert.deepEqual(lookupCredentialIdentity([syntheticPerson], "Valentina"), { status: "not_found", candidates: [] });
  assert.deepEqual(lookupCredentialIdentity([syntheticPerson], "20-00000000-2"), { status: "invalid_cuit", candidates: [] });
});

test("deduplica registros legacy y canónicos por CUIT y prefiere el canónico", () => {
  const lookup = lookupCredentialIdentity([
    { ...syntheticPerson, displayName: "Nombre legacy", storageVersion: 1 },
    syntheticPerson,
  ], "Valentina Quiroga");
  assert.deepEqual(lookup, { status: "resolved", identity: syntheticPerson });
  assert.throws(() => lookupCredentialIdentity([syntheticPerson, { ...syntheticPerson }], "Valentina Quiroga"), /duplicados/);
});

function identity(cuit: string, displayName: string): CredentialIdentityMetadata {
  return { issuerKey: cuit, cuit, displayName, storageVersion: 2 };
}
