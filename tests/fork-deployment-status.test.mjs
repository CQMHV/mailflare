import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { SqliteDatabase } from "./helpers/d1-sqlite.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-deployment-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { getLatestDeployment } from "./src/lib/fork-deployment-status.ts";
			export { forkDeployment } from "./src/lib/fork-deployment-config.ts";
			export { GET } from "./src/app/api/admin/deployment/route.ts";
			export { getDeploymentStatus } from "./src/components/admin-update-card-utils.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
		`, resolveDir: root, sourcefile: "deployment-status-entry.ts",
	},
	outfile: join(directory, "entry.mjs"), bundle: true, platform: "node", format: "esm",
	target: "node24", tsconfig: join(root, "tsconfig.json"), packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const head = "a".repeat(40);
const previous = "b".repeat(40);
const commit = (sha, message = "Install change\n\nDetails") => ({ sha, commit: { message } });
const check = (sha, overrides = {}) => ({
	id: 20, head_sha: sha, name: "Workers Builds: mailflare",
	app: { slug: "cloudflare-workers-and-pages" }, check_suite: { head_branch: "main" },
	status: "completed", conclusion: "success",
	started_at: "2026-10-14T17:43:07Z", completed_at: "2026-10-14T17:43:07Z",
	details_url: `${app.forkDeployment.deploymentsUrl}/362a6814-097f-4b46-ba1f-74b3c7702e4a`,
	...overrides,
});

function mockGitHub(t, commits, checks) {
	const calls = [];
	t.mock.method(globalThis, "fetch", async (input, init) => {
		const url = new URL(String(input));
		calls.push(url);
		assert.equal(url.origin, "https://api.github.com");
		assert.equal(new Headers(init.headers).get("Authorization"), null);
		assert.equal(new Headers(init.headers).get("Cookie"), null);
		assert.ok(init.signal instanceof AbortSignal);
		assert.equal(init.redirect, "error");
		assert.deepEqual(init.cf.cacheTtlByStatus, { "200-299": 300, "400-599": -1 });
		if (url.pathname === "/repos/CQMHV/mailflare/commits") {
			assert.equal(url.searchParams.get("sha"), "main");
			assert.equal(url.searchParams.get("per_page"), "5");
			return Response.json(commits);
		}
		const sha = url.pathname.match(/\/commits\/([a-f0-9]{40})\/check-runs$/)?.[1];
		assert.ok(sha && sha in checks, `Unexpected request: ${url}`);
		assert.equal(url.searchParams.get("check_name"), "Workers Builds: mailflare");
		return Response.json({ check_runs: checks[sha] });
	});
	return calls;
}

async function fixture(t) {
	const database = new SqliteDatabase();
	t.after(() => database.db.close());
	await app.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`INSERT INTO users (id,email,password_hash,name,role,is_primary_admin,created_at) VALUES
		('owner','owner@example.test','hash','Owner','admin',1,1),
		('admin','admin@example.test','hash','Admin','admin',0,1),
		('member','member@example.test','hash','Member','user',0,1)`);
	const env = { DB: database, BUCKET: {}, MAILFLARE_RUNTIME: "node", CF_TOKEN: "DO-NOT-TRANSMIT", GITHUB_UPDATE_TOKEN: "DO-NOT-TRANSMIT-EITHER" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const sessions = {};
	for (const id of ["owner", "admin", "member"]) sessions[id] = await app.createSession(env, id);
	return (id) => new Request("https://mailflare.test/api/admin/deployment", { headers: { Authorization: `Bearer ${sessions[id] ?? "invalid"}` } });
}

test("deployment lookup authorizes real sessions before any external request", async (t) => {
	const request = await fixture(t);
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Unauthorized lookup must not fetch"); });
	for (const [id, expected] of [["guest", 401], ["admin", 403], ["member", 403]]) {
		assert.equal((await app.GET(request(id))).status, expected);
	}
	assert.equal(calls, 0);
});

test("primary admin gets the Cloudflare build, never another app, worker, branch or account", async (t) => {
	const request = await fixture(t);
	const valid = check(head);
	const other = (overrides) => check(head, { id: 99, completed_at: "2026-10-14T18:00:00Z", ...overrides });
	mockGitHub(t, [commit(head)], { [head]: [
		other({ app: { slug: "github-actions" } }), other({ name: "Workers Builds: other" }),
		other({ check_suite: { head_branch: "preview" } }), other({ head_sha: previous }),
		other({ details_url: "https://dash.cloudflare.com/another-account/builds/362a6814-097f-4b46-ba1f-74b3c7702e4a" }),
		other({ details_url: `${app.forkDeployment.deploymentsUrl}/362a6814-097f-4b46-ba1f-74b3c7702e4a?unexpected=1` }), valid,
	] });
	const response = await app.GET(request("owner"));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
	const data = await response.json();
	assert.equal(data.headPending, false);
	assert.deepEqual(data.latest, {
		state: "success", commit: head, commitMessage: "Install change",
		commitUrl: `${app.forkDeployment.repositoryUrl}/commit/${head}`, detailsUrl: valid.details_url,
		startedAt: "2026-10-14T17:43:07.000Z", completedAt: "2026-10-14T17:43:07.000Z",
	});
	assert.ok(!JSON.stringify(data).includes("DO-NOT-TRANSMIT"));
});

test("an unreported main head keeps the previous result explicitly associated with its commit", async (t) => {
	mockGitHub(t, [commit(head), commit(previous, "Previous deployment")], { [head]: [], [previous]: [check(previous)] });
	const data = await app.getLatestDeployment();
	assert.equal(data.headPending, true);
	assert.equal(data.latest.commit, previous);
	assert.equal(data.latest.commitMessage, "Previous deployment");
});

test("a newer check for an earlier main commit is selected by its check-run sequence", async (t) => {
	mockGitHub(t, [commit(head), commit(previous)], {
		[head]: [check(head)],
		[previous]: [check(previous, { id: 21, conclusion: "failure", started_at: "2026-10-14T18:00:00Z", completed_at: "2026-10-14T18:00:00Z" })],
	});
	const data = await app.getLatestDeployment();
	assert.equal(data.latest.commit, previous);
	assert.equal(data.latest.state, "failure");
	assert.equal(data.headPending, false);
});

test("queued, running, cancelled, skipped and unknown results never become success", async (t) => {
	let run;
	t.mock.method(globalThis, "fetch", async (input) => new URL(String(input)).pathname.endsWith("/check-runs")
		? Response.json({ check_runs: [run] }) : Response.json([commit(head)]));
	for (const [status, conclusion, expected] of [
		["queued", null, "queued"], ["in_progress", null, "running"],
		["completed", "cancelled", "cancelled"], ["completed", "neutral", "skipped"],
		["completed", "timed_out", "failure"], ["completed", null, "unknown"], ["new_state", "success", "unknown"],
	]) {
		run = check(head, { status, conclusion, started_at: null, completed_at: null });
		const data = await app.getLatestDeployment();
		assert.equal(data.latest.state, expected);
		assert.equal(data.latest.startedAt, null);
		assert.equal(data.latest.completedAt, null);
	}
});

test("a newer running build is not hidden when an older build completes after it starts", async (t) => {
	mockGitHub(t, [commit(head), commit(previous)], {
		[head]: [check(head, { status: "in_progress", conclusion: null, started_at: "2026-10-14T10:03:00Z", completed_at: null })],
		[previous]: [check(previous, { id: 19, started_at: "2026-10-14T10:04:00Z", completed_at: "2026-10-14T10:04:00Z" })],
	});
	assert.equal((await app.getLatestDeployment()).latest.state, "running");
});

test("a new queued check without timestamps is not hidden by an older completed check", async (t) => {
	mockGitHub(t, [commit(head), commit(previous)], {
		[head]: [check(head, { status: "queued", conclusion: null, started_at: null, completed_at: null })],
		[previous]: [check(previous, { id: 19 })],
	});
	assert.equal((await app.getLatestDeployment()).latest.state, "queued");
});

test("no matching Cloudflare check returns no deployment, rather than an invented success", async (t) => {
	mockGitHub(t, [commit(head)], { [head]: [] });
	assert.deepEqual(await app.getLatestDeployment(), { latest: null, headPending: true });
});

test("rate limits, non-JSON and invalid upstream data produce a safe JSON error", async (t) => {
	const request = await fixture(t);
	let response;
	t.mock.method(globalThis, "fetch", async () => response.clone());
	for (const upstream of [
		new Response("<html>provider outage</html>", { status: 502 }),
		Response.json({ message: "rate limit DO-NOT-TRANSMIT" }, { status: 403 }),
		Response.json([{ sha: "not a valid commit", commit: { message: "bad" } }]),
	]) {
		response = upstream;
		const result = await app.GET(request("owner"));
		assert.equal(result.status, 502);
		assert.deepEqual(await result.json(), { error: "Could not retrieve the latest deployment status" });
	}
});

test("a partial GitHub lookup failure does not report another commit as the latest", async (t) => {
	t.mock.method(globalThis, "fetch", async (input) => {
		const url = String(input);
		if (!url.includes("/check-runs")) return Response.json([commit(head), commit(previous)]);
		if (url.includes(head)) return new Response("Bad gateway", { status: 502 });
		return Response.json({ check_runs: [check(previous)] });
	});
	await assert.rejects(app.getLatestDeployment(), /Could not read/);
});

test("client deployment lookup handles HTML errors without exposing a JSON parsing error", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response("<!doctype html>", { status: 502 }));
	await assert.rejects(app.getDeploymentStatus(), /Could not retrieve the latest deployment status/);
});
