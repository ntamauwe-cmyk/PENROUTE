/**
 * ============================================================================
 * GITHUB PULL REQUEST CONTROL — read/update/merge the hardening PR
 * ----------------------------------------------------------------------------
 * Pure "use node" actions calling the GitHub REST pull-request API:
 *   GET    /repos/{owner}/{repo}/pulls/{n}          → status + head/base SHAs
 *   GET    /repos/{owner}/{repo}/commits/{ref}/check-runs → CI results
 *   PATCH  /repos/{owner}/{repo}/pulls/{n}          → title/body/draft
 *   PUT    /repos/{owner}/{repo}/pulls/{n}/merge    → merge
 *
 * Everything is `internalAction`: callable only from server code or the
 * audited terminal workflow (`bun convex run`), never from a browser.
 * Owner/repository/PR number are compile-time constants so the token can
 * never be pointed at an arbitrary URL (no SSRF / token exfiltration path).
 *
 * The token lives ONLY in the server environment (platform Keys tab):
 *   GITHUB_TOKEN — classic personal access token with the `repo` scope.
 * ============================================================================
 */
"use node";

import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";

const GITHUB_API = "https://api.github.com";
const OWNER = "ntamauwe-cmyk";
const REPO = "PENROUTE";
const PR_NUMBER = 2;

interface PullRequestInfo {
  number: number;
  node_id: string;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeable_state?: string;
  title: string;
  body: string | null;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
}

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

type PrStatusResult = {
  ok: boolean;
  reason?: string;
  number?: number;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  mergeableState?: string;
  title?: string;
  headSha?: string;
  headRef?: string;
  baseRef?: string;
  checks?: CheckRun[];
  checksPass?: boolean;
};

type PrActionResult = {
  ok: boolean;
  reason?: string;
  merged?: boolean;
  sha?: string;
  message?: string;
  title?: string;
  draft?: boolean;
};

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

async function requireToken(): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not configured. Add a GitHub personal access token (classic, with the repo scope) in the platform Keys tab.",
    );
  }
  return token;
}

/** Read-only PR snapshot: state, draft flag, SHAs and CI check conclusions. */
export const internalPrStatus = internalAction({
  args: {},
  handler: async (): Promise<PrStatusResult> => {
    const token = await requireToken();
    try {
      const pr = await gh<PullRequestInfo>(
        `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`,
        token,
      );
      let checks: CheckRun[] = [];
      try {
        const runs = await gh<{ check_runs: CheckRun[] }>(
          `/repos/${OWNER}/${REPO}/commits/${pr.head.sha}/check-runs`,
          token,
        );
        checks = runs.check_runs ?? [];
      } catch {
        // Check-runs endpoint may be unavailable (no CI yet) — not fatal.
      }
      const finished = checks.filter((c) => c.status === "completed");
      const checksPass =
        checks.length === 0 ||
        (finished.length === checks.length &&
          finished.every(
            (c) => c.conclusion === "success" || c.conclusion === "neutral",
          ));
      return {
        ok: true,
        number: pr.number,
        state: pr.state,
        draft: pr.draft,
        merged: pr.merged,
        mergeableState: pr.mergeable_state,
        title: pr.title,
        headSha: pr.head.sha,
        headRef: pr.head.ref,
        baseRef: pr.base.ref,
        checks,
        checksPass,
      };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  },
});

/**
 * Convert a draft PR to ready-for-review. The REST PATCH `draft: false`
 * field is silently ignored by GitHub, so this goes through the GraphQL
 * `markPullRequestReadyForReview` mutation instead (REST for title/body).
 */
export const internalMarkReady = internalAction({
  args: {},
  handler: async (): Promise<PrActionResult> => {
    const token = await requireToken();
    try {
      const pr = await gh<PullRequestInfo>(
        `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`,
        token,
      );
      const res = await fetch(`${GITHUB_API}/graphql`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query:
            "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft state } } }",
          variables: { id: pr.node_id },
        }),
      });
      const data = (await res.json()) as {
        data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft: boolean; state: string } } };
        errors?: { message: string }[];
      };
      if (!res.ok || data.errors?.length) {
        return {
          ok: false,
          reason: data.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`,
        };
      }
      const prOut = data.data?.markPullRequestReadyForReview?.pullRequest;
      return { ok: true, draft: prOut?.isDraft ?? false };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  },
});

/** Replace the PR title/body (draft flag is handled by internalMarkReady). */
export const internalUpdatePr = internalAction({
  args: {
    title: v.optional(v.string()),
    body: v.optional(v.string()),
    draft: v.optional(v.boolean()),
  },
  handler: async (
    _ctx: ActionCtx,
    args: { title?: string; body?: string; draft?: boolean },
  ): Promise<PrActionResult> => {
    const token = await requireToken();
    try {
      const patch: Record<string, unknown> = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.body !== undefined) patch.body = args.body;
      if (args.draft !== undefined) patch.draft = args.draft;
      delete patch.draft; // REST cannot un-draft; internalMarkReady does that.
      if (Object.keys(patch).length === 0) {
        return { ok: false, reason: "Nothing to update." };
      }
      const pr = await gh<PullRequestInfo>(
        `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`,
        token,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
      return { ok: true, title: pr.title, draft: pr.draft };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  },
});

/** Read-only: current branch protection on `main` (404 → none configured). */
export const internalGetBranchProtection = internalAction({
  args: {},
  handler: async (): Promise<{ ok: boolean; reason?: string; protection?: unknown }> => {
    const token = await requireToken();
    try {
      const res = await fetch(
        `${GITHUB_API}/repos/${OWNER}/${REPO}/branches/main/protection`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (res.status === 404) return { ok: true, protection: null };
      if (!res.ok) {
        return { ok: false, reason: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
      }
      return { ok: true, protection: await res.json() };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  },
});

/**
 * Configure standard protection for `main`: PRs only, the CI `checks` job
 * required before merge, no force pushes, no deletions. Admin bypass left ON
 * so the audited operator path is not bricked; adjust via GitHub settings if
 * stricter enforcement is wanted.
 */
export const internalSetBranchProtection = internalAction({
  args: {},
  handler: async (): Promise<{ ok: boolean; reason?: string; status?: number }> => {
    const token = await requireToken();
    try {
      const body = {
        required_status_checks: { strict: true, contexts: ["checks"] },
        enforce_admins: false,
        required_pull_request_reviews: {
          required_approving_review_count: 0,
          dismiss_stale_reviews: false,
          require_code_owner_reviews: false,
          require_last_push_approval: false,
        },
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false,
        required_conversation_resolution: false,
        required_linear_history: false,
      };
      const res = await fetch(
        `${GITHUB_API}/repos/${OWNER}/${REPO}/branches/main/protection`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      const text = await res.text();
      if (!res.ok) return { ok: false, status: res.status, reason: text.slice(0, 300) };
      return { ok: true, status: res.status };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  },
});

/** Read-only diagnostics: fetch CI job logs (plain text, via redirect). */
export const internalJobLogs = internalAction({
  args: { jobId: v.string(), maxChars: v.optional(v.number()) },
  handler: async (
    _ctx: ActionCtx,
    args: { jobId: string; maxChars?: number },
  ): Promise<{ ok: boolean; reason?: string; log?: string }> => {
    const token = await requireToken();
    try {
      const url = `${GITHUB_API}/repos/${OWNER}/${REPO}/actions/jobs/${args.jobId}/logs`;
      const res = await fetch(url, {
        redirect: "manual",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      let text: string;
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { ok: false, reason: "Redirect without location." };
        const signed = await fetch(location); // signed URL — no auth header needed
        text = await signed.text();
      } else if (res.ok) {
        text = await res.text();
      } else {
        return { ok: false, reason: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
      }
      const limit = args.maxChars ?? 12000;
      return { ok: true, log: text.slice(0, limit) };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  },
});

/** Merge the PR. Callers MUST have verified `internalPrStatus` first. */
export const internalMergePr = internalAction({
  args: {
    commitTitle: v.optional(v.string()),
    commitMessage: v.optional(v.string()),
    mergeMethod: v.optional(v.string()),
  },
  handler: async (
    _ctx: ActionCtx,
    args: { commitTitle?: string; commitMessage?: string; mergeMethod?: string },
  ): Promise<PrActionResult> => {
    const token = await requireToken();
    try {
      const method = args.mergeMethod ?? "merge";
      if (method !== "merge" && method !== "squash" && method !== "rebase") {
        return { ok: false, reason: `Invalid merge method: ${method}` };
      }
      const res = await gh<{ merged: boolean; sha?: string; message?: string }>(
        `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/merge`,
        token,
        {
          method: "PUT",
          body: JSON.stringify({
            merge_method: method,
            ...(args.commitTitle ? { commit_title: args.commitTitle } : {}),
            ...(args.commitMessage ? { commit_message: args.commitMessage } : {}),
          }),
        },
      );
      if (!res.merged) {
        return { ok: false, reason: res.message ?? "Merge was not performed." };
      }
      return { ok: true, merged: true, sha: res.sha, message: res.message };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  },
});
