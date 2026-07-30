import { ensureRuntimeLayout, type RuntimePaths, useLauncherVerifiedRuntimeLayout } from "../config/runtimePaths.js";
import {
  acknowledgeSessionRuntimeAclVerification,
  type SessionRuntimeAclVerificationMessage,
  waitForSessionRuntimeAclVerification,
} from "./sessionLauncher.js";

export type SessionRuntimeDependencies = {
  ensure: () => Promise<RuntimePaths>;
  waitForVerification: (target: NodeJS.Process, signal: AbortSignal, timeoutMs: number) => Promise<SessionRuntimeAclVerificationMessage>;
  useVerification: (root: string) => Promise<RuntimePaths>;
  acknowledge: (target: NodeJS.Process, verificationId: string) => Promise<void>;
};

const defaultDependencies: SessionRuntimeDependencies = {
  ensure: ensureRuntimeLayout,
  waitForVerification: waitForSessionRuntimeAclVerification,
  useVerification: useLauncherVerifiedRuntimeLayout,
  acknowledge: acknowledgeSessionRuntimeAclVerification,
};

export async function resolveSessionRuntime(
  launcherManaged: boolean,
  target: NodeJS.Process,
  signal: AbortSignal,
  dependencies: SessionRuntimeDependencies = defaultDependencies,
): Promise<RuntimePaths> {
  if (!launcherManaged) return dependencies.ensure();
  if (!target.connected) throw new Error("El worker administrado no recibió un canal IPC del launcher.");
  const verification = await dependencies.waitForVerification(target, signal, 10_000);
  const runtime = await dependencies.useVerification(verification.root);
  if (signal.aborted) throw new Error("La atestación del runtime fue cancelada.");
  await dependencies.acknowledge(target, verification.verificationId);
  if (signal.aborted) throw new Error("La atestación del runtime fue cancelada.");
  return runtime;
}
