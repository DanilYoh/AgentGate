import {
  lstat,
  readFile,
  readdir,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ncc from "@vercel/ncc";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(project, "action", "dist");
const check = process.argv.includes("--check");
const result = await ncc(resolve(project, "action", "src", "index.ts"), {
  cache: false,
  minify: true,
  sourceMap: false,
  license: "licenses.txt",
  target: "es2022",
  quiet: true,
});
const expected = new Map([["index.js", result.code]]);
for (const [name, asset] of Object.entries(result.assets)) {
  expected.set(name, asset.source);
}

function resolveAsset(name) {
  const path = resolve(outputDirectory, name);
  const localPath = relative(outputDirectory, path);
  if (
    localPath === "" ||
    localPath === ".." ||
    localPath.startsWith(`..${sep}`) ||
    isAbsolute(localPath)
  ) {
    throw new Error(`Refusing unsafe Action asset path: ${name}`);
  }
  return path;
}

async function inventory(directory, prefix = "") {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      names.push(...(await inventory(resolve(directory, entry.name), name)));
    } else {
      names.push(name);
    }
  }
  return names;
}

const expectedPaths = new Map(
  [...expected].map(([name, source]) => [
    name,
    { path: resolveAsset(name), source },
  ]),
);

if (check) {
  const outputStats = await lstat(outputDirectory);
  if (!outputStats.isDirectory()) {
    throw new Error("Committed Action bundle path is not a directory.");
  }
  const actualNames = (await inventory(outputDirectory)).sort();
  const expectedNames = [...expected.keys()].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `Action bundle files are stale: expected ${expectedNames.join(", ")}, found ${actualNames.join(", ")}.`,
    );
  }
  for (const [name, { path, source }] of expectedPaths) {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new Error(`Action bundle ${name} is not a regular file.`);
    }
    const actual = await readFile(path);
    const wanted = Buffer.isBuffer(source) ? source : Buffer.from(source);
    if (!actual.equals(wanted)) {
      throw new Error(
        `Action bundle ${name} is stale; run npm run bundle:action.`,
      );
    }
  }
  console.log("Verified committed GitHub Action bundle.");
} else {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  for (const { path, source } of expectedPaths.values()) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
  }
  console.log(`Bundled GitHub Action into ${outputDirectory}.`);
}
