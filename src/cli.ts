#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCli } from "./run-cli.js";

export { runCli } from "./run-cli.js";
export type { CliExecutionConstraints, CliIo } from "./run-cli.js";

async function isEntryPoint(): Promise<boolean> {
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  try {
    const [modulePath, executablePath] = await Promise.all([
      realpath(fileURLToPath(import.meta.url)),
      realpath(entryPath),
    ]);
    return modulePath === executablePath;
  } catch {
    return import.meta.url === pathToFileURL(entryPath).href;
  }
}

if (await isEntryPoint()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
