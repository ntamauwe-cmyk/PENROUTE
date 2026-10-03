/**
 * ============================================================================
 * GITHUB SYNC — push the Penroute source to the user's EXISTING repository
 * ----------------------------------------------------------------------------
 * Pure "use node" action calling the GitHub REST API (Git Data flow):
 *   blobs → tree → commit → update branch ref
 *
 * Runs against the CURRENT head commit, so existing repository files are
 * preserved (nothing is deleted). Single commit, message:
 *   "Initial Penroute application commit"
 *
 * Empty-repository handling: GitHub's Git Data API refuses blob creation on a
 * repo with zero commits (409). This action seeds the first commit through the
 * Contents API (README), then collapses the history into ONE root commit with
 * a CAS-guarded ref update — never overwriting foreign work.
 *
 * The token lives ONLY in the server environment (platform Keys tab):
 *   GITHUB_TOKEN — classic personal access token with the `repo` scope.
 * ============================================================================
 */
"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { createHash } from "node:crypto";

const GITHUB_API = "https://api.github.com";
const COMMIT_MESSAGE = "Initial Penroute application commit";

interface RepoInfo {
  full_name: string;
  private: boolean;
  default_branch: string;
  permissions?: { push?: boolean };
}

interface TreeEntry {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string;
}

/** Git blob object ID: sha1("blob <size>" + NUL + content). */
function gitBlobShaOf(buf: Buffer): string {
  const header = Buffer.concat([Buffer.from(`blob ${buf.length}`, "utf8"), Buffer.alloc(1)]);
  return createHash("sha1").update(header).update(buf).digest("hex");
}

async function gh<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status} on ${path}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** Verify the repo exists and the token can push to it. */
export const verifyRepo = action({
  args: { owner: v.string(), repo: v.string() },
  handler: async (_ctx, { owner, repo }) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return {
        ok: false as const,
        reason:
          "GITHUB_TOKEN is not configured. Add a GitHub personal access token (classic, with the repo scope) in the platform Keys tab.",
      };
    }
    try {
      const info = await gh<RepoInfo>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token);
      const canPush = info.permissions?.push !== false;
      return {
        ok: canPush,
        fullName: info.full_name,
        isPrivate: info.private,
        defaultBranch: info.default_branch,
        reason: canPush ? undefined : "Token does not have push access to this repository",
      };
    } catch (e) {
      return {
        ok: false as const,
        reason: e instanceof Error ? e.message : "Repository lookup failed",
      };
    }
  },
});

/**
 * THE PUSH — one commit containing the whole project source, built on top of
 * the repository's current head so existing files are preserved.
 */
export const pushToGitHub = action({
  args: {
    owner: v.string(),
    repo: v.string(),
    branch: v.optional(v.string()),
    pushId: v.string(),
    // Optional commit subject; defaults to the initial-commit message used by
    // the seed/bootstrap flow above. Lets audited re-pushes carry their own
    // message without ever rewriting existing history.
    message: v.optional(v.string()),
  },
  handler: async (ctx, { owner, repo, branch, pushId, message }) => {
    const commitMessage = message?.trim() || COMMIT_MESSAGE;
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return {
        ok: false as const,
        error:
          "GITHUB_TOKEN is not configured. Add a GitHub personal access token (classic, repo scope) in the platform Keys tab, then retry.",
      };
    }

    // 1) Verify repo + resolve the target branch
    let repoInfo: RepoInfo;
    try {
      repoInfo = await gh<RepoInfo>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token);
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "Repo lookup failed" };
    }
    const refName = branch ?? repoInfo.default_branch ?? "main";

    // 2) Current head commit (build on top of it — nothing is deleted)
    let baseCommitSha: string | null = null;
    let baseTreeSha: string | null = null;
    // A "seed head" is a head commit created by a previous attempt of this same
    // flow (empty-repo workaround): our exact commit message and a tree with at
    // most one blob. Such a commit may be replaced by the final root commit.
    let seedHead = false;
    try {
      const ref = await gh<{ object: { sha: string } }>(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(refName)}`,
        token,
      );
      baseCommitSha = ref.object.sha;
      const head = await gh<{ message: string; tree: { sha: string } }>(
        `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`,
        token,
      );
      baseTreeSha = head.tree.sha;
      const headTree = await gh<{ tree: { type: string }[] }>(
        `/repos/${owner}/${repo}/git/trees/${head.tree.sha}`,
        token,
      );
      if (head.message === COMMIT_MESSAGE && headTree.tree.filter((t) => t.type === "blob").length <= 1) {
        seedHead = true;
      }
    } catch {
      // Empty repository — the push will create the first commit.
    }

    // Existing tree (to reuse unchanged blobs — idempotent re-pushes)
    const existingTree = baseTreeSha
      ? await gh<{ tree: { path: string; sha: string | null }[] }>(
          `/repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`,
          token,
        )
      : null;
    const existingByPath = new Map(
      (existingTree?.tree ?? [])
        .filter((t) => t.sha)
        .map((t) => [t.path, t.sha as string]),
    );

    // 2b) Empty-repository bootstrap: seed the first commit through the
    //     Contents API with the README, then continue with the normal flow.
    let bootstrapped = false;
    const probe = (await ctx.runQuery(internal.githubSyncData.internalStagedPage, {
      pushId,
      limit: 1,
    })) as unknown as { first?: { path: string; contentBase64: string } | null };
    const seed = probe.first ?? null;
    if (!baseCommitSha && seed) {
      try {
        const created = await gh<{ commit: { sha: string } }>(
          `/repos/${owner}/${repo}/contents/${encodeURIComponent(seed.path)}`,
          token,
          {
            method: "PUT",
            body: JSON.stringify({ message: COMMIT_MESSAGE, content: seed.contentBase64 }),
          },
        );
        baseCommitSha = created.commit.sha;
        const seedCommit = await gh<{ tree: { sha: string } }>(
          `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`,
          token,
        );
        baseTreeSha = seedCommit.tree.sha;
        bootstrapped = true;
        seedHead = true;
        // The seeded file already exists in the base tree — reuse its blob.
        existingByPath.set(seed.path, gitBlobShaOf(Buffer.from(seed.contentBase64, "base64")));
      } catch {
        // Fall through — blob creation below surfaces a clear 409 if this failed.
      }
    }

    // 3) Stream staged files → create blobs → build tree entries
    const tree: TreeEntry[] = [];
    let committed = 0;
    let skippedUnchanged = 0;
    const failed: { path: string; error: string }[] = [];
    const PAGE = 50;

    for (;;) {
      // Each page is marked committed/failed below, so the next query returns
      // the next chunk of still-staged rows — always take from the front.
      const { page } = await ctx.runQuery(internal.githubSyncData.internalStagedPage, {
        pushId,
        limit: PAGE,
      });
      if (page.length === 0) break;

      const okIds: Array<{ id: string }> = [];
      const failIds: Array<{ id: string }> = [];
      for (const f of page) {
        try {
          const buf = Buffer.from(f.contentBase64, "base64");
          const blobId = gitBlobShaOf(buf);
          if (existingByPath.get(f.path) === blobId) {
            // Identical content already in the repo — reuse the existing blob.
            tree.push({ path: f.path, mode: "100644", type: "blob", sha: blobId });
            skippedUnchanged++;
            okIds.push({ id: f.id });
            continue;
          }
          const blob = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/blobs`, token, {
            method: "POST",
            body: JSON.stringify({ content: f.contentBase64, encoding: "base64" }),
          });
          tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
          committed++;
          okIds.push({ id: f.id });
        } catch (e) {
          failed.push({ path: f.path, error: e instanceof Error ? e.message : "blob upload failed" });
          failIds.push({ id: f.id });
        }
      }
      if (okIds.length > 0) {
        await ctx.runMutation(internal.githubSyncData.internalMarkStatus, {
          ids: okIds.map((x) => x.id) as never[],
          status: "committed",
        });
      }
      if (failIds.length > 0) {
        await ctx.runMutation(internal.githubSyncData.internalMarkStatus, {
          ids: failIds.map((x) => x.id) as never[],
          status: "failed",
        });
      }
    }

    if (tree.length === 0) {
      return {
        ok: false as const,
        error: "No files staged for this push. Run Stage files first.",
        failures: failed.slice(0, 10),
      };
    }
    if (failed.length > 0) {
      return {
        ok: false as const,
        error: `${failed.length} file(s) failed to upload — aborting the commit so the branch is never left half-written.`,
        failures: failed.slice(0, 10),
      };
    }

    // 4) Create the tree (base_tree preserves every repo file not in our manifest)
    const newTree = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/trees`, token, {
      method: "POST",
      body: JSON.stringify({ base_tree: baseTreeSha ?? undefined, tree }),
    });

    // 5) Create the commit. When replacing a seed commit created by this flow,
    //    make it a ROOT commit so history ends up as exactly one clean commit.
    const replacingSeed = bootstrapped || seedHead;
    const commit = await gh<{ sha: string; html_url: string }>(`/repos/${owner}/${repo}/git/commits`, token, {
      method: "POST",
      body: JSON.stringify({
        message: commitMessage,
        tree: newTree.sha,
        parents: baseCommitSha && !replacingSeed ? [baseCommitSha] : [],
      }),
    });

    // 6) Move the branch ref. Never overwrites foreign work:
    //    - normal case: fast-forward only (force: false)
    //    - seed replacement: CAS — only if the head is still the seed commit
    if (baseCommitSha && replacingSeed) {
      const refNow = await gh<{ object: { sha: string } }>(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(refName)}`,
        token,
      );
      if (refNow.object.sha !== baseCommitSha) {
        throw new Error("Repository head moved during push — aborting instead of overwriting foreign work.");
      }
      await gh(`/repos/${owner}/${repo}/git/refs/heads/${refName}`, token, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: true }),
      });
    } else if (baseCommitSha) {
      await gh(`/repos/${owner}/${repo}/git/refs/heads/${refName}`, token, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
    } else {
      await gh(`/repos/${owner}/${repo}/git/refs`, token, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${refName}`, sha: commit.sha }),
      });
    }

    return {
      ok: true as const,
      commitSha: commit.sha,
      commitUrl: commit.html_url,
      branch: refName,
      filesCommitted: committed,
      filesUnchanged: skippedUnchanged,
      filesFailed: failed.length,
      failures: failed.slice(0, 10),
    };
  },
});
