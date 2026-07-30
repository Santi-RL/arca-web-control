import fs from "node:fs/promises";
import path from "node:path";
import { isProcessAlive } from "../io/processLock.js";
import { acquireLocalOsMutex } from "../io/osMutex.js";
import type { RuntimePaths } from "./runtimePaths.js";

export async function acquireRuntimeMaintenanceTransition(runtime: RuntimePaths): Promise<() => Promise<void>> {
  return await acquireLocalOsMutex(
    `runtime-maintenance-transition\0${path.resolve(runtime.root)}`,
    "la transición entre mantenimiento y actividad fiscal",
  );
}

export async function assertNoLiveRuntimeActivity(
  runtime: RuntimePaths,
  processIsAlive: (pid: number) => boolean = isProcessAlive,
): Promise<void> {
  const indicators = [
    { label: "sesión ARCA", file: path.join(runtime.sessions, "current.json") },
    { label: "sesión ARCA", file: path.join(runtime.sessions, "current.lock") },
    { label: "aprendizaje ARCA", file: path.join(runtime.learning, "current.json") },
    { label: "aprendizaje ARCA", file: path.join(runtime.learning, "current.lock") },
  ];

  for (const indicator of indicators) {
    const pid = await readPrivatePidIfExists(indicator.file, indicator.label);
    if (pid !== undefined && processIsAlive(pid)) {
      throw new Error(`No se puede reparar el runtime mientras haya una ${indicator.label} activa. Cerrala de forma controlada y volvé a intentar.`);
    }
  }
}

async function readPrivatePidIfExists(filePath: string, label: string): Promise<number | undefined> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("invalid-runtime-activity-file");
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as { pid?: unknown };
    if (!Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 0 || (raw.pid as number) > 2_147_483_647) {
      throw new Error("invalid-runtime-activity-pid");
    }
    return raw.pid as number;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`No se pudo verificar el estado privado de ${label}; la reparación se bloquea por seguridad.`);
  }
}
