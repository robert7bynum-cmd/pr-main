import "server-only";

/**
 * Which deployment is this?
 *
 * Vercel builds every branch, so from now on there are three kinds of running
 * app rather than two, and several things have to behave differently on a
 * preview than on the real one: placards must not be printed against a URL
 * that dies with the branch, and the demo sign-in buttons are welcome on a
 * preview and forbidden in production.
 *
 * Every one of those decisions reads from here. Two copies of "am I a preview"
 * would drift the first time someone checked NODE_ENV instead — and NODE_ENV
 * is "production" on a preview deployment too, which is exactly the trap.
 */
export type DeploymentEnv = "development" | "preview" | "production";

/**
 * VERCEL_ENV is set by Vercel on every deployment and absent locally. Note
 * that Vercel also sets it to "development" for `vercel dev`, so the fallback
 * only covers a plain `next dev` / `next start` on someone's machine.
 */
export function deploymentEnv(): DeploymentEnv {
  const env = process.env.VERCEL_ENV;
  if (env === "production" || env === "preview" || env === "development") return env;
  return "development";
}

export function isPreview(): boolean {
  return deploymentEnv() === "preview";
}

export interface DeploymentRef {
  env: DeploymentEnv;
  /** Short commit SHA, or null when running outside Vercel. */
  commit: string | null;
  /** Branch name the deployment was built from. */
  branch: string | null;
  /**
   * The branch-stable preview URL (`…-git-<branch>-<scope>.vercel.app`) rather
   * than the per-deployment one, so a link pasted into a PR keeps working when
   * the branch is pushed again.
   */
  url: string | null;
}

export function deploymentRef(): DeploymentRef {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  const url = process.env.VERCEL_BRANCH_URL ?? process.env.VERCEL_URL ?? null;
  return {
    env: deploymentEnv(),
    commit: sha ? sha.slice(0, 7) : null,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    url: url ? `https://${url}` : null,
  };
}
