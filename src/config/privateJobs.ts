import fs from "node:fs/promises";
import path from "node:path";

const maximumPrivateJobBytes = 64 * 1024;

export type PrivateInvoiceJobFile = {
  path: string;
  contents: string;
};

export async function resolvePrivateInvoiceJobPath(value: string, privateJobsRoot: string, trustedRuntimeRoot: string): Promise<string> {
  try {
    return (await inspectPrivateInvoiceJobPath(value, privateJobsRoot, trustedRuntimeRoot)).candidateReal;
  } catch {
    throw new Error("El job debe ser un archivo JSON regular dentro de la carpeta privada jobs\\private del runtime local.");
  }
}

export async function readPrivateInvoiceJobFile(
  value: string,
  privateJobsRoot: string,
  trustedRuntimeRoot: string,
): Promise<PrivateInvoiceJobFile> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const inspected = await inspectPrivateInvoiceJobPath(value, privateJobsRoot, trustedRuntimeRoot);
    handle = await fs.open(inspected.lexicalCandidate, "r");
    const descriptorBefore = await handle.stat({ bigint: true });
    assertPrivateJobFileStat(descriptorBefore);
    const pathBefore = await fs.lstat(inspected.lexicalCandidate, { bigint: true });
    assertPrivateJobFileStat(pathBefore);
    if (!sameFileSnapshot(descriptorBefore, pathBefore)) throw new Error("job-replaced-before-read");
    const realBefore = await fs.realpath(inspected.lexicalCandidate);
    if (!samePath(realBefore, inspected.candidateReal)) throw new Error("job-realpath-changed-before-read");

    const contents = await handle.readFile("utf8");
    const descriptorAfter = await handle.stat({ bigint: true });
    const pathAfter = await fs.lstat(inspected.lexicalCandidate, { bigint: true });
    assertPrivateJobFileStat(descriptorAfter);
    assertPrivateJobFileStat(pathAfter);
    if (!sameFileSnapshot(descriptorBefore, descriptorAfter) || !sameFileSnapshot(descriptorAfter, pathAfter)) {
      throw new Error("job-replaced-during-read");
    }
    const realAfter = await fs.realpath(inspected.lexicalCandidate);
    if (!samePath(realAfter, inspected.candidateReal)) throw new Error("job-realpath-changed-during-read");
    return { path: inspected.candidateReal, contents };
  } catch {
    throw new Error("El job debe ser un archivo JSON regular, único e inmutable dentro de la carpeta privada jobs\\private del runtime local.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isPrivateJobHandle(value: string): boolean {
  return /^(?:invoice-[a-f0-9]{64}|invoice-\d{4}-\d{2}-\d{2}-[a-f0-9-]{16,64})\.json$/iu.test(value);
}

async function inspectPrivateInvoiceJobPath(
  value: string,
  privateJobsRoot: string,
  trustedRuntimeRoot: string,
): Promise<{ lexicalCandidate: string; candidateReal: string }> {
  const repositoryReal = await fs.realpath(process.cwd());
  const trustedPath = path.resolve(trustedRuntimeRoot);
  const trustedStat = await fs.lstat(trustedPath);
  if (!trustedStat.isDirectory() || trustedStat.isSymbolicLink()) throw new Error("invalid-runtime-root");
  const trustedReal = await fs.realpath(trustedPath);
  if (isWithin(repositoryReal, trustedReal)) throw new Error("runtime-inside-repository");

  const jobsPath = path.resolve(privateJobsRoot);
  const jobsStat = await fs.lstat(jobsPath);
  if (!jobsStat.isDirectory() || jobsStat.isSymbolicLink()) throw new Error("invalid-jobs-root");
  const jobsReal = await fs.realpath(jobsPath);
  if (!isWithin(trustedReal, jobsReal) || isWithin(repositoryReal, jobsReal)) throw new Error("escaped-jobs-root");

  const lexicalCandidate = isPrivateJobHandle(value) ? path.resolve(jobsPath, value) : path.resolve(value);
  if (path.extname(lexicalCandidate).toLowerCase() !== ".json") throw new Error("invalid-extension");
  if (!isWithin(jobsPath, lexicalCandidate) || samePath(jobsPath, lexicalCandidate)) throw new Error("lexical-escape");
  const candidateStat = await fs.lstat(lexicalCandidate);
  assertPrivateJobFileStat(candidateStat);
  const candidateReal = await fs.realpath(lexicalCandidate);
  if (!isWithin(jobsReal, candidateReal) || isWithin(repositoryReal, candidateReal)) throw new Error("canonical-escape");
  return { lexicalCandidate, candidateReal };
}

function assertPrivateJobFileStat(stat: { isFile(): boolean; isSymbolicLink(): boolean; nlink: number | bigint; size: number | bigint }): void {
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1 || Number(stat.size) > maximumPrivateJobBytes) {
    throw new Error("invalid-job-file");
  }
}

function sameFileSnapshot(
  left: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeNs?: bigint; ctimeNs?: bigint; mtimeMs?: number | bigint; ctimeMs?: number | bigint },
  right: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeNs?: bigint; ctimeNs?: bigint; mtimeMs?: number | bigint; ctimeMs?: number | bigint },
): boolean {
  const time = (stat: typeof left, field: "mtime" | "ctime") => {
    const nanoseconds = field === "mtime" ? stat.mtimeNs : stat.ctimeNs;
    return nanoseconds === undefined ? String(field === "mtime" ? stat.mtimeMs : stat.ctimeMs) : String(nanoseconds);
  };
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.size) === String(right.size)
    && time(left, "mtime") === time(right, "mtime")
    && time(left, "ctime") === time(right, "ctime");
}

function samePath(left: string, right: string): boolean {
  const normalize = (entry: string) => {
    const resolved = path.resolve(entry);
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
