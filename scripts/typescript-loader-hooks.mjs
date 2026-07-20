import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);

  const basePath = resolvePath(repoRoot, specifier.slice(2));
  const candidate = [basePath, `${basePath}.ts`, `${basePath}.tsx`, `${basePath}.mjs`, `${basePath}.js`].find((path) => existsSync(path));
  if (!candidate) return nextResolve(specifier, context);

  return { url: pathToFileURL(candidate).href, shortCircuit: true };
}
