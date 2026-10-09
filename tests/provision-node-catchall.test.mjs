import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

function provisionSrc() {
	return read("src/lib/domains/provision.ts");
}

function stripComments(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function loadCatchAllDecision() {
	const context = vm.createContext({});
	for (const [path, names] of [
		["src/lib/runtime.ts", ["getNodeEnv", "isNodeRuntime"]],
		["src/lib/domains/provision.ts", ["shouldBindEmailCatchAllToWorker"]],
	]) {
		const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
		for (const name of names) {
			const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
			assert.ok(declaration, `${name} must exist in ${path}`);
			const code = ts.transpileModule(declaration.getText(source).replace(/^export /, ""), {
				compilerOptions: { target: ts.ScriptTarget.ES2022 },
			}).outputText;
			vm.runInContext(code, context);
		}
	}
	return context.shouldBindEmailCatchAllToWorker;
}

test("Worker catch-all keeps the default while Node opts out (issue #42)", () => {
	const shouldBindEmailCatchAllToWorker = loadCatchAllDecision();

	assert.equal(shouldBindEmailCatchAllToWorker({ MAILFLARE_RUNTIME: "node" }), false);
	assert.equal(shouldBindEmailCatchAllToWorker({ MAILFLARE_RUNTIME: "cloudflare" }), true);
	assert.equal(shouldBindEmailCatchAllToWorker({}), true);
	assert.equal(shouldBindEmailCatchAllToWorker(undefined), true);
});

test("only explicit false disables automatic Worker catch-all binding", () => {
	const shouldBindEmailCatchAllToWorker = loadCatchAllDecision();
	assert.equal(shouldBindEmailCatchAllToWorker({ MAILFLARE_CATCH_ALL: false }), false);
	assert.equal(shouldBindEmailCatchAllToWorker({ MAILFLARE_CATCH_ALL: "false" }), false);
	assert.equal(shouldBindEmailCatchAllToWorker({ MAILFLARE_CATCH_ALL: true }), true);
	assert.equal(shouldBindEmailCatchAllToWorker({ MAILFLARE_CATCH_ALL: "true" }), true);
	assert.equal(shouldBindEmailCatchAllToWorker({ MAILFLARE_CATCH_ALL: "" }), true);
	assert.equal(shouldBindEmailCatchAllToWorker({ MAILFLARE_CATCH_ALL: "False" }), true);
	assert.equal(shouldBindEmailCatchAllToWorker({ MAILFLARE_RUNTIME: "node", MAILFLARE_CATCH_ALL: true }), false);
});

test("provision.ts imports isNodeRuntime next to hasCloudflareCredentials", () => {
	const src = provisionSrc();
	assert.match(
		src,
		/import\s*\{[^}]*isNodeRuntime[^}]*\}\s*from\s*"@\/lib\/runtime"/,
		"isNodeRuntime must be imported from @/lib/runtime",
	);
	assert.match(
		src,
		/import\s*\{[^}]*hasCloudflareCredentials[^}]*\}\s*from\s*"@\/lib\/runtime"/,
	);
});

test("Worker catch-all PUT is skipped on Node and kept on Workers (issue #42)", () => {
	const src = stripComments(provisionSrc());
	const call = "await ensureEmailRoutingCatchAllToWorker(env, zone.id);";
	const idx = src.indexOf(call);
	assert.notEqual(idx, -1, "Workers path must still call ensureEmailRoutingCatchAllToWorker");
	assert.equal(src.indexOf(call, idx + 1), -1, "exactly one catch-all bind call");

	const before = src.slice(Math.max(0, idx - 220), idx);
	assert.match(
		before,
		/if\s*\(\s*(?:!isNodeRuntime\(\s*env\s*\)|shouldBindEmailCatchAllToWorker\(\s*env\s*\))\s*\)\s*\{/,
		"ensureEmailRoutingCatchAllToWorker must be gated by Node runtime so Docker/Node does not PUT worker catch-all",
	);

	const enableRouting = src.match(/if\s*\(\s*enableRouting\s*\)\s*\{([\s\S]*?)\n\t\}/);
	assert.ok(enableRouting, "enableRouting block not found");
	assert.match(
		enableRouting[1],
		/enableEmailRouting\(/,
		"Node with CF credentials must still enable Email Routing; only the Worker catch-all is skipped",
	);
	assert.ok(
		!/isNodeRuntime|shouldBindEmailCatchAllToWorker/.test(
			enableRouting[1].slice(0, enableRouting[1].indexOf("enableEmailRouting(")),
		),
		"enableEmailRouting must not be gated by isNodeRuntime",
	);
});

test("the Node skip lives at the provision call site, not in the PUT helper", () => {
	const catchAll = read("src/lib/domains/catch-all-routing.ts");
	assert.ok(
		!/\bisNodeRuntime\b/.test(catchAll),
		"do not hide the Node skip inside ensureEmailRoutingCatchAllToWorker",
	);
	assert.match(catchAll, /export async function ensureEmailRoutingCatchAllToWorker/);
});
