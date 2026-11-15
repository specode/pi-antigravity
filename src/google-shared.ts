import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type * as GoogleShared from "@earendil-works/pi-ai/api/google-shared";

/**
 * Pi 1.5.2 aliases the pi-ai root, but not its api/* subpaths, for extensions.
 * Resolve the host's public export using public Node/Pi APIs instead of relying
 * on this extension's devDependencies or bundling a second Pi implementation.
 */
const anchor = join(getPackageDir(), "package.json");
const manifestPath = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(anchor));
if (!manifestPath) throw new Error("The Pi host does not provide @earendil-works/pi-ai.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  exports?: Record<string, string | { import?: string }>;
};
const entry = manifest.exports?.["./api/google-shared"] ?? manifest.exports?.["./api/*"];
const target = typeof entry === "string" ? entry : entry?.import;
if (typeof target !== "string" || !target.startsWith("./")) {
  throw new Error("The Pi host does not expose the public Google converter API.");
}
const googleShared = await import(
  pathToFileURL(resolve(dirname(manifestPath), target.replace("*", "google-shared"))).href
) as typeof GoogleShared;

export const { convertMessages, convertTools, mapToolChoice } = googleShared;
