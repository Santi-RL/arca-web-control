import { sanitizeArcaUrlForOutput } from "./officialUrls.js";

const embeddedUrlPattern = /(?:https?:\/\/|data:|javascript:)[^\s"'<>]+/gi;
const windowsProfilePathPattern = /\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"'<>]+[\\/]/gi;
const unixProfilePathPattern = /\/(?:Users|home)\/[^/\s"'<>]+\//g;

export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(embeddedUrlPattern, (value) => sanitizeArcaUrlForOutput(value))
    .replace(windowsProfilePathPattern, "[ruta-privada]/")
    .replace(unixProfilePathPattern, "[ruta-privada]/")
    .replace(/(\n\s*-\s+cookie:\s*).+/gi, "$1[redacted]");
}
