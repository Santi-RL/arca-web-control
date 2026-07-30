import { createHash } from "node:crypto";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const inProcessFallback = new Set<string>();

export type LocalOsMutexOptions = {
  timeoutMs?: number;
  retryDelayMs?: number;
};

/**
 * Mutex local de proceso cruzado. En Windows usa un named pipe: el kernel lo
 * libera automáticamente ante una caída, por lo que no existen locks
 * persistentes huérfanos que deban borrarse con una carrera TOCTOU.
 */
export async function acquireLocalOsMutex(
  identity: string,
  label: string,
  options: LocalOsMutexOptions = {},
): Promise<() => Promise<void>> {
  const digest = createHash("sha256").update(identity, "utf8").digest("hex");
  const timeoutMs = options.timeoutMs ?? 0;
  const retryDelayMs = options.retryDelayMs ?? 50;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) {
    throw new Error("El timeout del mutex local no es válido.");
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 10 || retryDelayMs > 1_000) {
    throw new Error("El intervalo del mutex local no es válido.");
  }
  const deadline = Date.now() + timeoutMs;

  if (process.platform !== "win32") {
    while (inProcessFallback.has(digest)) {
      await waitForMutexOrThrow(label, deadline, timeoutMs, retryDelayMs);
    }
    inProcessFallback.add(digest);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      inProcessFallback.delete(digest);
    };
  }

  const pipeName = `\\\\.\\pipe\\ManejoARCA-${digest}`;
  let server: net.Server;
  while (true) {
    const attempt = await tryAcquirePipe(pipeName, label);
    if (attempt !== "busy") {
      server = attempt;
      break;
    }
    await waitForMutexOrThrow(label, deadline, timeoutMs, retryDelayMs);
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

async function tryAcquirePipe(pipeName: string, label: string): Promise<net.Server | "busy"> {
  const server = net.createServer((socket) => socket.destroy());
  return await new Promise<net.Server | "busy">((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      if (error.code === "EADDRINUSE") resolve("busy");
      else reject(new Error(`No se pudo adquirir ${label}.`));
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(pipeName);
  });
}

async function waitForMutexOrThrow(label: string, deadline: number, timeoutMs: number, retryDelayMs: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (timeoutMs === 0) throw new Error(`${label} ya está en uso por otra operación local.`);
  if (remaining <= 0) {
    throw new Error(`${label} no quedó disponible dentro del tiempo límite; no se inició la operación.`);
  }
  await delay(Math.min(retryDelayMs, remaining));
}
