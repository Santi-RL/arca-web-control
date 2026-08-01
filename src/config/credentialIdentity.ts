import { isValidCuit } from "../jobs/schema.js";

export type CredentialIdentityMetadata = {
  issuerKey: string;
  displayName: string;
  cuit: string;
  storageVersion: number;
};

export type CredentialIdentityLookup =
  | { status: "resolved"; identity: CredentialIdentityMetadata }
  | { status: "ambiguous"; candidates: CredentialIdentityMetadata[] }
  | { status: "needs_confirmation"; candidates: CredentialIdentityMetadata[] }
  | { status: "not_found"; candidates: [] }
  | { status: "invalid_cuit"; candidates: [] };

const legalEntityForms = new Set(["SA", "SAU", "SAS", "SRL", "SC", "SCA", "SCS", "SH", "UTE"]);

/**
 * Resuelve exclusivamente sobre metadatos no secretos. Las coincidencias
 * aproximadas nunca se convierten en una identidad lista para iniciar sesión.
 */
export function lookupCredentialIdentity(
  records: CredentialIdentityMetadata[],
  selector: string,
): CredentialIdentityLookup {
  const identities = canonicalIdentities(records);
  const numeric = /^\s*[\d.\-\s]+\s*$/u.test(selector);
  if (numeric) {
    const cuit = selector.replace(/\D/g, "");
    if (!isValidCuit(cuit)) return { status: "invalid_cuit", candidates: [] };
    const identity = identities.find((candidate) => candidate.cuit === cuit);
    return identity ? { status: "resolved", identity } : { status: "not_found", candidates: [] };
  }

  const requested = normalizeIdentityName(selector);
  if (!requested) return { status: "not_found", candidates: [] };
  const exact = identities.filter((candidate) => normalizeIdentityName(candidate.displayName) === requested);
  if (exact.length === 1) return { status: "resolved", identity: exact[0] as CredentialIdentityMetadata };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact };

  const requestedTokens = identityTokens(selector);
  const suggestions = identities.filter((candidate) => namesAreBoundedSuggestion(
    requestedTokens,
    identityTokens(candidate.displayName),
  ));
  return suggestions.length > 0
    ? { status: "needs_confirmation", candidates: suggestions }
    : { status: "not_found", candidates: [] };
}

export function formatCredentialCuit(cuit: string): string {
  return `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`;
}

function canonicalIdentities(records: CredentialIdentityMetadata[]): CredentialIdentityMetadata[] {
  const byCuit = new Map<string, CredentialIdentityMetadata>();
  for (const record of records) {
    const projected = {
      issuerKey: record.cuit,
      displayName: record.displayName.trim(),
      cuit: record.cuit,
      storageVersion: record.storageVersion,
    };
    const current = byCuit.get(projected.cuit);
    if (!current || projected.storageVersion > current.storageVersion) {
      byCuit.set(projected.cuit, projected);
      continue;
    }
    if (projected.storageVersion === current.storageVersion) {
      throw new Error("El índice contiene registros duplicados para un mismo CUIT y versión de almacenamiento.");
    }
  }
  return [...byCuit.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName, "es-AR") || left.cuit.localeCompare(right.cuit));
}

function normalizeIdentityName(value: string): string {
  return identityTokens(value).join(" ");
}

function identityTokens(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/u)
    .filter(Boolean);
}

function namesAreBoundedSuggestion(requested: string[], candidate: string[]): boolean {
  const requestedName = splitLegalEntityForm(requested);
  const candidateName = splitLegalEntityForm(candidate);
  if (requestedName.legalForm !== candidateName.legalForm
    || requestedName.tokens.length < 2
    || Math.abs(requestedName.tokens.length - candidateName.tokens.length) > 1) return false;

  const remaining = [...candidateName.tokens];
  const unmatchedRequested: string[] = [];
  for (const token of requestedName.tokens) {
    const exactIndex = remaining.indexOf(token);
    if (exactIndex >= 0) remaining.splice(exactIndex, 1);
    else unmatchedRequested.push(token);
  }
  if (unmatchedRequested.length === 0) return remaining.length <= 1;
  if (unmatchedRequested.length !== 1 || remaining.length < 1 || remaining.length > 2) return false;
  const left = unmatchedRequested[0] as string;
  const typoMatches = remaining.filter((right) => Math.min(left.length, right.length) >= 6
    && !/^\d+$/u.test(left)
    && !/^\d+$/u.test(right)
    && isSingleCharacterTypo(left, right));
  return typoMatches.length === 1;
}

function splitLegalEntityForm(tokens: string[]): { tokens: string[]; legalForm?: string } {
  for (let length = Math.min(3, tokens.length); length >= 1; length -= 1) {
    const candidate = tokens.slice(-length).join("");
    if (legalEntityForms.has(candidate)) return { tokens: tokens.slice(0, -length), legalForm: candidate };
  }
  return { tokens };
}

function isSingleCharacterTypo(left: string, right: string): boolean {
  const difference = left.length - right.length;
  if (Math.abs(difference) > 1) return false;
  if (difference === 0) {
    const indexes: number[] = [];
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) indexes.push(index);
      if (indexes.length > 2) return false;
    }
    if (indexes.length === 1) return true;
    if (indexes.length !== 2) return false;
    const first = indexes[0] as number;
    const second = indexes[1] as number;
    return second === first + 1 && left[first] === right[second] && left[second] === right[first];
  }

  const longer = difference > 0 ? left : right;
  const shorter = difference > 0 ? right : left;
  let longIndex = 0;
  let shortIndex = 0;
  let skipped = false;
  while (longIndex < longer.length && shortIndex < shorter.length) {
    if (longer[longIndex] === shorter[shortIndex]) {
      longIndex += 1;
      shortIndex += 1;
    } else {
      if (skipped) return false;
      skipped = true;
      longIndex += 1;
    }
  }
  return true;
}
