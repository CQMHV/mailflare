import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(root, "node_modules", "migration-auth-test-"));
after(() => {
	rmSync(temporary, { recursive: true, force: true });
	delete globalThis.migrationAuthFixture;
});
const mocks = {
	"next/server": "export const NextResponse = { json: (data, init) => Response.json(data, init) };",
	"@/lib/cloudflare": "export function getEnv() { return globalThis.migrationAuthFixture.env; }",
	"@/lib/auth/cookies": "export async function requireUser() { const user = globalThis.migrationAuthFixture.user; if (!user) throw new Error('Unauthorized'); return user; }",
	"@/lib/migrations/service": `
		export async function getMigrationStatus(db) {
			globalThis.migrationAuthFixture.calls.push({ operation: 'status', db });
			return { ready: true, pending: [], unknown: [] };
		}
		export async function applyPendingMigrations(db) {
			globalThis.migrationAuthFixture.calls.push({ operation: 'apply', db });
			return { ready: true, pending: [], unknown: [], applied: [] };
		}
	`,
};
await build({
	entryPoints: [join(root, "src/app/api/admin/migrations/route.ts")],
	outfile: join(temporary, "route.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "migration-auth-fixture",
		setup(builder) {
			builder.onResolve({ filter: /^(next\/server|@\/lib\/(cloudflare|auth\/cookies|migrations\/service))$/ }, ({ path }) => ({ path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents: mocks[path], loader: "js" }));
		},
	}],
	logLevel: "silent",
});
const routes = await import(pathToFileURL(join(temporary, "route.mjs")).href);
const primary = { role: "admin", isPrimaryAdmin: true };
function fixture(user) {
	return globalThis.migrationAuthFixture = { user, env: { DB: {} }, calls: [] };
}
function request(method, origin) {
	return new Request("https://mail.test/api/admin/migrations", {
		method,
		headers: origin === undefined ? {} : { Origin: origin },
	});
}

test("unauthenticated migration requests cannot read or apply migrations", async () => {
	const state = fixture(null);
	for (const method of ["GET", "POST"]) {
		assert.equal((await routes[method](request(method, "https://mail.test"))).status, 401);
	}
	assert.deepEqual(state.calls, []);
});

test("only the primary administrator can read or apply migrations", async () => {
	for (const user of [{ role: "user", isPrimaryAdmin: false }, { role: "admin", isPrimaryAdmin: false }, { role: "user", isPrimaryAdmin: true }]) {
		const state = fixture(user);
		for (const method of ["GET", "POST"]) {
			assert.equal((await routes[method](request(method, "https://mail.test"))).status, 403);
		}
		assert.deepEqual(state.calls, []);
	}
});

test("primary administrator can check status and apply same-origin migrations", async () => {
	const state = fixture(primary);
	const status = await routes.GET(request("GET"));
	assert.equal(status.status, 200);
	assert.deepEqual(await status.json(), { ready: true, pending: [], unknown: [] });
	assert.equal((await routes.POST(request("POST", "https://mail.test"))).status, 200);
	assert.deepEqual(state.calls, [{ operation: "status", db: state.env.DB }, { operation: "apply", db: state.env.DB }]);
});

test("migration writes without the exact same origin are rejected before database access", async () => {
	const state = fixture(primary);
	for (const origin of [undefined, "null", "https://other.test", "http://mail.test"]) {
		assert.equal((await routes.POST(request("POST", origin))).status, 403);
	}
	assert.deepEqual(state.calls, []);
});
