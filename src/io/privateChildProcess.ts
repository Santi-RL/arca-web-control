import { spawn } from "node:child_process";
import { sanitizeErrorMessage } from "../arca/publicErrors.js";

export type PrivateChildProcessOptions = {
  stdin?: string;
  cwd?: string;
  maxOutputBytes?: number;
  acceptedExitCodes?: readonly number[];
  timeoutMs?: number;
};

export async function runPrivateChildProcess(
  command: string,
  args: string[],
  options: PrivateChildProcessOptions = {},
): Promise<{ stdout: string; exitCode: number }> {
  const maximum = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error("El límite de salida del subproceso no es válido.");
  const acceptedExitCodes = options.acceptedExitCodes ?? [0];
  if (!acceptedExitCodes.length || acceptedExitCodes.some((code) => !Number.isSafeInteger(code) || code < 0 || code > 255)) {
    throw new Error("Los códigos de salida admitidos no son válidos.");
  }
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("El plazo del subproceso local no es válido.");

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      fail(new Error("El comando local excedió el plazo permitido y fue detenido; no se reintentó."));
    }, timeoutMs);

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { child.kill(); } catch { /* El rechazo no puede quedar bloqueado por el cierre. */ }
      reject(error);
    };
    const append = (target: Buffer[], chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes > maximum) {
        fail(new Error("El comando local superó el límite privado de salida."));
        return;
      }
      target.push(buffer);
    };

    child.once("error", () => fail(new Error("No se pudo iniciar el comando local solicitado.")));
    if (!child.stdout || !child.stderr || (options.stdin !== undefined && !child.stdin)) {
      fail(new Error("No se pudieron abrir los canales privados del comando local."));
      return;
    }
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.stdin?.once("error", () => fail(new Error("No se pudo entregar la entrada privada al comando local.")));
    // `close`, a diferencia de `exit`, ocurre después de cerrar y drenar los
    // canales stdout/stderr.
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== null && acceptedExitCodes.includes(code)) resolve({ stdout: stdoutText, exitCode: code });
      else reject(new Error(stderrText
        ? sanitizeErrorMessage(stderrText)
        : `El comando local terminó con código ${code ?? "desconocido"}.`));
    });
    if (options.stdin !== undefined) child.stdin!.end(options.stdin);
  });
}
