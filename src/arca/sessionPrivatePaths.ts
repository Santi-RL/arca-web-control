import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../types.js";
import { ensurePrivateDirectory } from "../config/runtimePaths.js";

export async function prepareSessionPrivatePaths(options: {
  config: Pick<RuntimeConfig, "runtimeRoot" | "profileRoot">;
  issuerKey: string;
  artifactName: string;
  artifactRoot?: string;
}): Promise<{ artifactDir: string; profileDir: string }> {
  if (!/^[a-zA-Z0-9_-]{1,200}$/u.test(options.artifactName)) {
    throw new Error("El identificador del directorio de artefactos de sesión no es válido.");
  }
  const runtimeRoot = path.resolve(options.config.runtimeRoot);
  const artifactRoot = path.resolve(options.artifactRoot ?? path.join(runtimeRoot, "sessions", "artifacts"));
  const profileRoot = path.resolve(options.config.profileRoot);
  if (!isWithin(runtimeRoot, artifactRoot) || !isWithin(runtimeRoot, profileRoot)) {
    throw new Error("Los perfiles y artefactos de sesión deben permanecer dentro del runtime privado.");
  }
  const profileDir = path.join(profileRoot, `session_${sanitizePathPart(options.issuerKey)}`);
  await ensurePrivateDirectory(artifactRoot);
  await ensurePrivateDirectory(profileDir);
  const artifactDir = path.join(artifactRoot, options.artifactName);
  await fs.mkdir(artifactDir);
  return { artifactDir, profileDir };
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
