/**
 * The seed repos' tests need `python` with pytest and flask on PATH. Rather than trust the host,
 * we build a small venv under DATA_DIR once and prepend its bin to the sandbox PATH.
 */
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { settings } from "./config";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);
let venvBin: string | null = null;

export function sandboxPath(): string {
  const base = process.env.PATH ?? "/usr/bin:/bin";
  return venvBin && !base.split(path.delimiter).includes(venvBin) ? `${venvBin}${path.delimiter}${base}` : base;
}

export async function ensureSandboxPython(): Promise<string | null> {
  const venv = path.join(settings.dataDir, "sandbox-venv");
  const bin = path.join(venv, "bin");
  try {
    await access(path.join(bin, "pytest"));
    venvBin = bin;
    return bin;
  } catch { /* build it */ }
  for (const py of ["python3.12", "python3.11", "python3"]) {
    try {
      await execFileAsync(py, ["-m", "venv", venv], { timeout: 120_000 });
      await execFileAsync(path.join(bin, "python"), ["-m", "pip", "install", "-q", "--disable-pip-version-check", "pytest", "flask"], { timeout: 600_000 });
      venvBin = bin;
      logger.info({ venv, python: py }, "sandbox python ready");
      return bin;
    } catch (error) {
      logger.warn({ err: error, python: py }, "sandbox venv attempt failed");
    }
  }
  logger.error("no python available for the sandbox; run(\"test\") will fail in seed repos");
  return null;
}

/** Test hook. */
export function setSandboxBin(bin: string | null): void { venvBin = bin; }
