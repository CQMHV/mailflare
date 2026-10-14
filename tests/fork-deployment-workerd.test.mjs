import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const head = "a".repeat(40);
const githubOrigin = "https://api.github.com";
const commitsPath = "/repos/CQMHV/mailflare/commits?sha=main&per_page=5";
const checksQuery = new URLSearchParams({ check_name: "Workers Builds: mailflare", filter: "latest", per_page: "100" });
const checksPath = `/repos/CQMHV/mailflare/commits/${head}/check-runs?${checksQuery}`;

async function withWorker(outboundService, run) {
	const directory = mkdtempSync(join(root, "node_modules", "mailflare-deployment-workerd-test-"));
	let runtime;
	try {
		const scriptPath = join(directory, "worker.mjs");
		await build({
			stdin: {
				contents: `
					import { getLatestDeployment, GitHubDeploymentHttpError } from "./src/lib/fork-deployment-status.ts";
					export default {
						async fetch() {
							try {
								return Response.json(await getLatestDeployment());
							} catch (error) {
								return Response.json({
									name: error.name,
									status: error instanceof GitHubDeploymentHttpError ? error.status : null,
								}, { status: 500 });
							}
						}
					};
				`, resolveDir: root, sourcefile: "deployment-workerd-entry.ts",
			},
			outfile: scriptPath, bundle: true, platform: "browser", format: "esm",
			target: "es2022", tsconfig: join(root, "tsconfig.json"), logLevel: "silent",
		});
		// Miniflare 5's outbound service intercepts workerd's native global fetch;
		// it does not replace fetch inside the Worker or allow any external network.
		runtime = new Miniflare(convertV4MiniflareOptions({
			modules: true, scriptPath, compatibilityDate: "2026-05-20",
			compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
			outboundService, cf: false, telemetry: { enabled: false },
			unsafeRegisterWorker: false,
			resourcePersistencePath: join(directory, "state"),
			isolatedResourcePersistencePath: join(directory, "isolated-state"),
			resourceTmpPath: join(directory, "tmp"),
		}));
		await run(runtime);
	} finally {
		try {
			await runtime?.dispose();
		} finally {
			assert.equal(dirname(directory), join(root, "node_modules"));
			rmSync(directory, { recursive: true, force: true });
		}
	}
}

test("actual workerd fetch reads public GitHub deployment metadata without external networking", async () => {
	const calls = [];
	await withWorker((request) => {
		calls.push(request.url);
		assert.equal(request.method, "GET");
		assert.equal(request.headers.get("Authorization"), null);
		assert.equal(request.headers.get("Cookie"), null);
		if (request.url === `${githubOrigin}${commitsPath}`) {
			return Response.json([{ sha: head, commit: { message: "Runtime deployment fix\n\nDetails" } }]);
		}
		if (request.url === `${githubOrigin}${checksPath}`) {
			return Response.json({ check_runs: [{
				id: 20, head_sha: head, name: "Workers Builds: mailflare",
				app: { slug: "cloudflare-workers-and-pages" }, check_suite: { head_branch: "main" },
				status: "completed", conclusion: "success",
				started_at: "2026-10-15T10:00:00Z", completed_at: "2026-10-15T10:00:00Z",
				details_url: "https://dash.cloudflare.com/ed7beef1c506866d938a47bc0e96047b/workers/services/view/mailflare/production/builds/362a6814-097f-4b46-ba1f-74b3c7702e4a",
			}] });
		}
		throw new Error(`Unexpected outbound request: ${request.url}`);
	}, async (runtime) => {
		const response = await runtime.dispatchFetch("http://localhost/deployment");
		assert.equal(response.status, 200);
		const data = await response.json();
		assert.equal(data.latest.state, "success");
		assert.equal(data.latest.commit, head);
		assert.equal(data.latest.commitMessage, "Runtime deployment fix");
		assert.equal(data.headPending, false);
		assert.deepEqual(calls, [`${githubOrigin}${commitsPath}`, `${githubOrigin}${checksPath}`]);
	});
});

test("actual workerd fetch rejects a GitHub redirect without following it", async () => {
	const calls = [];
	await withWorker((request) => {
		calls.push(request.url);
		if (request.url !== `${githubOrigin}${commitsPath}`) {
			throw new Error(`Unexpected outbound request: ${request.url}`);
		}
		return new Response(null, { status: 302, headers: { Location: "https://redirect-target.invalid/deployment" } });
	}, async (runtime) => {
		const response = await runtime.dispatchFetch("http://localhost/deployment");
		assert.equal(response.status, 500);
		assert.deepEqual(await response.json(), { name: "GitHubDeploymentHttpError", status: 302 });
		assert.deepEqual(calls, [`${githubOrigin}${commitsPath}`]);
	});
});
