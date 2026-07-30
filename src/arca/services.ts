export type KnownArcaService = {
  name: string;
  systemId: string;
  aliases: string[];
};

const knownServices: KnownArcaService[] = [
  {
    name: "Sistema de cuentas tributarias",
    systemId: "cuenta_corriente_contrib",
    aliases: ["sistema de cuentas tributarias"],
  },
];

export function normalizeServiceName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function knownSystemId(serviceName: string): string | undefined {
  const normalized = normalizeServiceName(serviceName);
  return knownServices.find((service) => service.aliases.some((alias) => normalizeServiceName(alias) === normalized))?.systemId;
}

export function serviceNameToRegExp(value: string): RegExp {
  const escapedWords = normalizeServiceName(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => accentTolerantPattern(escapeRegExp(word)));

  return new RegExp(escapedWords.join("\\s+"), "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function accentTolerantPattern(value: string): string {
  return value
    .replace(/a/g, "[aá]")
    .replace(/e/g, "[eé]")
    .replace(/i/g, "[ií]")
    .replace(/o/g, "[oó]")
    .replace(/u/g, "[uúü]")
    .replace(/n/g, "[nñ]");
}
