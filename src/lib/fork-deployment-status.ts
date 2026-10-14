import { z } from "zod";
import { forkDeployment } from "./fork-deployment-config";
import type { DeploymentRecord, DeploymentState, DeploymentStatusResponse } from "./fork-deployment-types";

const commitsSchema = z.array(z.object({
	sha: z.string().regex(/^[a-f0-9]{40}$/i),
	commit: z.object({ message: z.string() }),
})).max(5);
const checksSchema = z.object({
	check_runs: z.array(z.object({
		id: z.number().int().positive(),
		name: z.string(),
		head_sha: z.string(),
		status: z.string(),
		conclusion: z.string().nullish(),
		details_url: z.string().nullish(),
		started_at: z.string().nullish(),
		completed_at: z.string().nullish(),
		app: z.object({ slug: z.string().optional() }).nullish(),
		check_suite: z.object({ head_branch: z.string().nullish() }).nullish(),
	})).max(100),
});

async function readGitHub(path: string, signal: AbortSignal): Promise<unknown> {
	// Only public metadata: never forward Mailflare sessions or use either deployment token.
	const response = await fetch(`https://api.github.com/repos/${forkDeployment.repository}/${path}`, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "mailflare-deployment-status",
			"X-GitHub-Api-Version": "2026-03-10",
		},
		signal,
		redirect: "error",
		cf: { cacheTtlByStatus: { "200-299": 300, "400-599": -1 } },
	});
	if (!response.ok) throw new Error("Could not read the Cloudflare deployment result from GitHub");
	return response.json();
}

function deploymentState(status: string, conclusion: string | null | undefined): DeploymentState {
	if (status === "in_progress") return "running";
	if (["queued", "waiting", "pending", "requested"].includes(status)) return "queued";
	if (status !== "completed") return "unknown";
	if (conclusion === "success") return "success";
	if (["failure", "timed_out", "action_required", "startup_failure"].includes(conclusion ?? "")) return "failure";
	if (conclusion === "cancelled") return "cancelled";
	if (["skipped", "neutral"].includes(conclusion ?? "")) return "skipped";
	return "unknown";
}

function timestamp(value: string | null | undefined): string | null {
	return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

export async function getLatestDeployment(): Promise<DeploymentStatusResponse> {
	const signal = AbortSignal.timeout(10_000);
	const commits = commitsSchema.parse(await readGitHub(`commits?sha=${forkDeployment.branch}&per_page=5`, signal));
	const lookups = await Promise.allSettled(commits.map(async (commit) => {
		const query = new URLSearchParams({ check_name: `Workers Builds: ${forkDeployment.worker}`, filter: "latest", per_page: "100" });
		const checks = checksSchema.parse(await readGitHub(`commits/${commit.sha}/check-runs?${query}`, signal));
		return checks.check_runs.flatMap((run) => {
			const buildId = run.details_url?.slice(forkDeployment.deploymentsUrl.length + 1);
			if (run.app?.slug !== "cloudflare-workers-and-pages"
				|| run.name !== `Workers Builds: ${forkDeployment.worker}`
				|| run.head_sha !== commit.sha
				|| (run.check_suite?.head_branch && run.check_suite.head_branch !== forkDeployment.branch)
				|| !run.details_url?.startsWith(`${forkDeployment.deploymentsUrl}/`)
				|| !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(buildId ?? "")) return [];
			const record: DeploymentRecord = {
				state: deploymentState(run.status, run.conclusion),
				commit: commit.sha,
				commitMessage: commit.commit.message.split("\n")[0],
				commitUrl: `${forkDeployment.repositoryUrl}/commit/${commit.sha}`,
				detailsUrl: run.details_url,
				startedAt: timestamp(run.started_at),
				completedAt: timestamp(run.completed_at),
			};
			return [{ id: run.id, record }];
		});
	}));
	// Do not present a partial lookup as the latest deployment if one lookup failed.
	const failure = lookups.find((lookup) => lookup.status === "rejected");
	if (failure?.status === "rejected") throw failure.reason;
	const records = lookups.flatMap((lookup) => lookup.status === "fulfilled" ? lookup.value : []);
	// Cloudflare may set started_at to the completion/report time. Keep check-run
	// creation order instead of comparing those timestamps with running builds.
	records.sort((left, right) => right.id - left.id);
	return {
		latest: records[0]?.record ?? null,
		headPending: !!commits[0] && !records.some(({ record }) => record.commit === commits[0].sha),
	};
}
