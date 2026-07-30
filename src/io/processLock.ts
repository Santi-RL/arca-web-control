import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readJsonIfExists } from "./atomicJson.js";

export async function acquireProcessLock(filePath: string, label: string, metadata: { launchId?: string } = {}): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const ownerToken = randomUUID();
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, "wx");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const lock = await readJsonIfExists<{ pid?: number }>(filePath).catch(() => undefined);
    if (lock?.pid && isProcessAlive(lock.pid)) throw new Error(`Ya existe ${label} activa (PID ${lock.pid}).`);
    throw new Error(`Existe un lock huérfano de ${label}. No se elimina automáticamente: verificá el PID y retiralo manualmente.`);
  }
  try {
    await handle.writeFile(JSON.stringify({ ...metadata, pid: process.pid, ownerToken, startedAt: new Date().toISOString() }));
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
  return async () => {
    await handle.close().catch(() => undefined);
    const current = await readJsonIfExists<{ ownerToken?: string }>(filePath).catch(() => undefined);
    if (current?.ownerToken === ownerToken) await fs.rm(filePath, { force: true }).catch(() => undefined);
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
