import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function canonicalTemporaryRoot(): Promise<string> {
  return await fs.realpath(os.tmpdir());
}

export async function makeCanonicalTemporaryDirectory(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(await canonicalTemporaryRoot(), prefix));
}
