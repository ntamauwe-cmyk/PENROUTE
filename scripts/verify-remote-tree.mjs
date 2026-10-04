#!/usr/bin/env node
/**
 * Audit helper: compare the local GitHub manifest against a remote branch tree.
 * Usage: node scripts/verify-remote-tree.mjs <owner> <repo> [branch]
 * Prints { same, changed[], missing[], remoteOnly[] } and exits 1 on any drift.
 * Read-only; uses anonymous GitHub API requests.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [owner, repo, branch = "main"] = process.argv.slice(2);
if (!owner || !repo) {
  console.error("usage: node scripts/verify-remote-tree.mjs <owner> <repo> [branch]");
  process.exit(2);
}

const src = readFileSync("src/lib/github-manifest.generated.ts", "utf8");
const m = src.match(/export const GITHUB_MANIFEST[^=]*= (\[[\s\S]*?\]);/);
if (!m) {
  console.error("GITHUB_MANIFEST not found — run: node scripts/generate-github-manifest.mjs");
  process.exit(2);
}
const manifest = new Function("return " + m[1])();

const gh = async (path) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { "User-Agent": "penroute-verify", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

const ref = await gh(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
const commit = await gh(`/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
const tree = await gh(`/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
const remote = new Map(
  tree.tree.filter((t) => t.type === "blob").map((t) => [t.path, t.sha]),
);

const blobSha = (buf) =>
  createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${buf.length}`, "utf8"), Buffer.alloc(1)]))
    .update(buf)
    .digest("hex");

let same = 0;
const changed = [];
const missing = [];
for (const f of manifest) {
  const sha = blobSha(readFileSync(f.path));
  const r = remote.get(f.path);
  if (r === undefined) missing.push(f.path);
  else if (r === sha) same++;
  else changed.push(f.path);
}
const localPaths = new Set(manifest.map((f) => f.path));
const remoteOnly = [...remote.keys()].filter((p) => !localPaths.has(p));

console.log(
  JSON.stringify(
    { branch, head: ref.object.sha, total: manifest.length, same, changed, missing, remoteOnly },
    null,
    2,
  ),
);
process.exit(changed.length === 0 && missing.length === 0 ? 0 : 1);
