import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { parseArgs } from "./cli.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), "mailflare-r2-snapshot-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
const outfile = join(outDir, "worker.mjs");
await build({
	entryPoints: [join(scriptDir, "worker.ts")], outfile, bundle: true,
	platform: "neutral", format: "esm", external: ["node:crypto"], target: "es2022", logLevel: "silent",
});
const { default: worker, backup, restore, verify, readManifest, manifestKey } = await import(pathToFileURL(outfile).href);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// Native R2's important semantics: streamed bodies, metadata, conditions returning bodyless objects/null,
// checksum validation, strong consistency and pagination that may return fewer than the requested limit.
class NativeR2Mock {
	objects = new Map();
	puts = [];
	pageSize = 1;
	version = 0;
	getHook;
	putHook;
	metadata(key) {
		const stored = this.objects.get(key);
		return stored ? {
			key, size: stored.bytes.byteLength, etag: sha256(stored.bytes), version: stored.version,
			uploaded: new Date("2026-10-09T00:00:00Z"), httpMetadata: { ...stored.httpMetadata },
			customMetadata: { ...stored.customMetadata },
		} : null;
	}
	async head(key) { return this.metadata(key); }
	async get(key, options = {}) {
		await this.getHook?.(key, options);
		const meta = this.metadata(key);
		if (!meta) return null;
		if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== meta.etag) return meta;
		const bytes = this.objects.get(key).bytes.slice();
		const body = new ReadableStream({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
				controller.close();
			},
		});
		return { ...meta, body, async json() { return JSON.parse(await new Response(body).text()); } };
	}
	async put(key, value, options = {}) {
		await this.putHook?.(key, value, options);
		const existing = this.metadata(key);
		if (options.onlyIf instanceof Headers && options.onlyIf.get("If-None-Match") === "*" && existing) return null;
		if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== existing?.etag) return null;
		const bytes = new Uint8Array(await new Response(value).arrayBuffer());
		if (options.sha256) assert.equal(sha256(bytes), Buffer.from(options.sha256).toString("hex"), "native checksum validation");
		this.objects.set(key, { bytes, version: String(++this.version),
			httpMetadata: { ...options.httpMetadata }, customMetadata: { ...options.customMetadata } });
		this.puts.push(key);
		return this.metadata(key);
	}
	async list({ cursor, limit = 1000 } = {}) {
		const keys = [...this.objects.keys()].sort();
		const start = Number(cursor ?? 0);
		const count = Math.min(limit, this.pageSize);
		const objects = keys.slice(start, start + count).map(key => this.metadata(key));
		const next = start + objects.length;
		return next < keys.length ? { objects, truncated: true, cursor: String(next) } : { objects, truncated: false };
	}
}

function environment() {
	return { SOURCE: new NativeR2Mock(), BACKUP: new NativeR2Mock(), TARGET: new NativeR2Mock(),
		SOURCE_BUCKET_NAME: "mailflare-raw", BACKUP_BUCKET_NAME: "mailflare-backups", TARGET_BUCKET_NAME: "mailflare-restore-test" };
}

async function seed(env) {
	await env.SOURCE.put("inbound/原始邮件.eml", "From: user@example.com\r\n\r\nHello", {
		httpMetadata: { contentType: "message/rfc822", contentLanguage: "zh-CN", cacheExpiry: new Date("2030-01-01T00:00:00Z") },
		customMetadata: { from: "user@example.com", to: "cqmhv@example.com" },
	});
	await env.SOURCE.put("attachments/msg/att/file%2F.bin", Uint8Array.of(0, 255, 127, 10, 128), {
		httpMetadata: { contentType: "application/octet-stream", contentDisposition: "attachment; filename=file.bin", cacheControl: "private" },
		customMetadata: { filename: "file.bin", messageId: "msg" },
	});
	await env.SOURCE.put("avatars/u:preview", new Uint8Array());
	await env.SOURCE.put("backups/database/id/records.json", "{\"tables\":{}}", { httpMetadata: { contentType: "application/json" } });
}

test("whole bucket paginates and round-trips binary, unusual keys, empty objects and metadata", async () => {
	const env = environment();
	await seed(env);
	const original = [...env.SOURCE.objects.keys()].sort();
	const manifest = await backup(env, "snapshot-1");
	assert.equal(manifest.status, "completed");
	assert.equal(manifest.objects.length, 4);
	assert.deepEqual([...env.SOURCE.objects.keys()].sort(), original, "source was never written/deleted");
	for (const entry of manifest.objects) {
		assert.match(entry.snapshotKey, /^snapshots\/snapshot-1\/objects\/[a-f0-9]{64}$/);
		assert.equal(entry.sha256, sha256(env.SOURCE.objects.get(entry.key).bytes));
	}
	const restored = await restore(env, "snapshot-1", "mailflare-restore-test");
	assert.equal(restored.verified, true);
	assert.equal(restored.restored, true);
	assert.equal(restored.objectCount, 4);
	for (const key of original) {
		assert.deepEqual(env.TARGET.objects.get(key).bytes, env.SOURCE.objects.get(key).bytes);
		assert.deepEqual(env.TARGET.objects.get(key).httpMetadata, env.SOURCE.objects.get(key).httpMetadata);
		assert.deepEqual(env.TARGET.objects.get(key).customMetadata, env.SOURCE.objects.get(key).customMetadata);
	}
});

test("snapshot IDs are immutable and incomplete snapshots cannot restore", async () => {
	const env = environment();
	await seed(env);
	await backup(env, "immutable");
	const manifestBytes = env.BACKUP.objects.get(manifestKey("immutable")).bytes.slice();
	await assert.rejects(backup(env, "immutable"), /SNAPSHOT_ALREADY_EXISTS/);
	assert.deepEqual(env.BACKUP.objects.get(manifestKey("immutable")).bytes, manifestBytes);
	const pending = { ...await readManifest(env, "immutable"), id: "pending", status: "in_progress", objects: [] };
	await env.BACKUP.put(manifestKey("pending"), JSON.stringify(pending));
	await assert.rejects(restore(env, "pending", env.TARGET_BUCKET_NAME), /SNAPSHOT_NOT_COMPLETED/);
	assert.equal(env.TARGET.puts.length, 0);
});

test("failed native R2 writes leave a failed manifest with no provider credentials", async () => {
	const env = environment();
	await seed(env);
	env.BACKUP.putHook = key => { if (key.includes("/objects/")) throw new Error("Bearer example-secret-token"); };
	await assert.rejects(backup(env, "failed"), /R2_OPERATION_FAILED/);
	const manifest = await readManifest(env, "failed");
	assert.equal(manifest.status, "failed");
	assert.equal(manifest.completedAt, undefined);
	assert.equal(manifest.error, "R2_OPERATION_FAILED");
	assert.ok(!JSON.stringify(manifest).includes("secret-token"));
	await assert.rejects(restore(env, "failed", env.TARGET_BUCKET_NAME), /SNAPSHOT_NOT_COMPLETED/);
});

test("source changes including metadata-only version changes abort instead of producing a completed snapshot", async () => {
	for (const metadataOnly of [false, true]) {
		const env = environment();
		await env.SOURCE.put("object", "before", { customMetadata: { original: "yes" } });
		let reads = 0;
		env.SOURCE.getHook = async () => {
			if (++reads === 2) await env.SOURCE.put("object", metadataOnly ? "before" : "after", { customMetadata: { changed: "yes" } });
		};
		await assert.rejects(backup(env, metadataOnly ? "metadata-change" : "content-change"), /OBJECT_(CHANGED|MISSING_OR_CHANGED)/);
		assert.equal((await readManifest(env, metadataOnly ? "metadata-change" : "content-change")).status, "failed");
	}
});

test("backup read-back detects corrupt content and metadata before marking completed", async () => {
	for (const metadataOnly of [false, true]) {
		const env = environment();
		await env.SOURCE.put("object", "content", { customMetadata: { preserve: "yes" } });
		env.BACKUP.getHook = key => {
			if (!key.includes("/objects/")) return;
			const stored = env.BACKUP.objects.get(key);
			if (metadataOnly) stored.customMetadata = {};
			else stored.bytes = new TextEncoder().encode("corrupt");
		};
		await assert.rejects(backup(env, "read-back"), /OBJECT_(CHECKSUM|METADATA)_MISMATCH/);
		assert.equal((await readManifest(env, "read-back")).status, "failed");
	}
});

test("restore refuses production/backup targets and nonempty isolated targets before writing", async () => {
	const env = environment();
	await seed(env);
	await backup(env, "safety");
	for (const target of ["mailflare-raw", "mailflare-backups", "other-bucket"]) {
		await assert.rejects(restore(env, "safety", target), /UNSAFE_RESTORE_TARGET/);
	}
	await assert.rejects(restore({ ...env, TARGET_BUCKET_NAME: "mailflare-raw" }, "safety", "mailflare-raw"), /UNSAFE_RESTORE_TARGET/);
	await env.TARGET.put("keep", "existing");
	const writeCount = env.TARGET.puts.length;
	await assert.rejects(restore(env, "safety", env.TARGET_BUCKET_NAME), /RESTORE_TARGET_NOT_EMPTY/);
	assert.equal(env.TARGET.puts.length, writeCount);
	assert.equal(new TextDecoder().decode(env.TARGET.objects.get("keep").bytes), "existing");
});

test("restore checks the backup checksum and rejects malformed manifest object paths", async () => {
	const env = environment();
	await env.SOURCE.put("object", "content");
	const manifest = await backup(env, "corrupt");
	env.BACKUP.objects.get(manifest.objects[0].snapshotKey).bytes = new TextEncoder().encode("changed");
	await assert.rejects(restore(env, "corrupt", env.TARGET_BUCKET_NAME), /OBJECT_CHECKSUM_MISMATCH/);
	assert.equal(env.TARGET.puts.length, 0);
	manifest.objects[0].snapshotKey = "outside-snapshot/object";
	await env.BACKUP.put(manifestKey("corrupt"), JSON.stringify(manifest));
	await assert.rejects(restore(env, "corrupt", env.TARGET_BUCKET_NAME), /INVALID_MANIFEST_OBJECT/);
});

test("verify detects extra keys, corrupted target content and target metadata changes", async () => {
	const env = environment();
	await env.SOURCE.put("object", "content", { httpMetadata: { contentType: "text/plain" } });
	await backup(env, "verify");
	await restore(env, "verify", env.TARGET_BUCKET_NAME);
	await env.TARGET.put("extra", "value");
	await assert.rejects(verify(env, "verify", env.TARGET_BUCKET_NAME), /RESTORE_INVENTORY_MISMATCH/);
	env.TARGET.objects.delete("extra");
	const original = env.TARGET.objects.get("object");
	const originalBytes = original.bytes;
	original.bytes = new TextEncoder().encode("corrupt");
	await assert.rejects(verify(env, "verify", env.TARGET_BUCKET_NAME), /OBJECT_CHECKSUM_MISMATCH/);
	original.bytes = originalBytes;
	original.httpMetadata = {};
	await assert.rejects(verify(env, "verify", env.TARGET_BUCKET_NAME), /OBJECT_METADATA_MISMATCH/);
});

test("an unsupported large object fails the snapshot explicitly instead of silently skipping it", async () => {
	const env = environment();
	env.SOURCE.list = async () => ({ truncated: false, objects: [{ key: "large", size: 5 * 1024 ** 3 - 5 * 1024 ** 2 + 1 }] });
	await assert.rejects(backup(env, "too-large"), /OBJECT_EXCEEDS_SINGLE_PUT_LIMIT/);
	assert.equal((await readManifest(env, "too-large")).status, "failed");
});

test("manifest publication respects R2's per-key write rate even for an empty snapshot", async () => {
	const env = environment();
	const writes = [];
	env.BACKUP.putHook = key => { if (key.endsWith("/manifest.json")) writes.push(performance.now()); };
	const manifest = await backup(env, "empty");
	assert.equal(manifest.status, "completed");
	assert.equal(writes.length, 2);
	assert.ok(writes[1] - writes[0] >= 1000);
	assert.equal((await restore(env, "empty", env.TARGET_BUCKET_NAME)).objectCount, 0);
});

test("local HTTP API rejects browser origins and public hostnames, and sanitizes unknown errors", async () => {
	const env = environment();
	const request = (url, headers = {}) => new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" });
	assert.equal((await worker.fetch(request("https://public.example/backup"), env)).status, 403);
	assert.equal((await worker.fetch(request("http://127.0.0.1/backup", { Origin: "https://evil.example" }), env)).status, 403);
	env.BACKUP.putHook = () => { throw new Error("example-secret-token"); };
	const response = await worker.fetch(request("http://127.0.0.1/backup"), env);
	assert.equal(response.status, 500);
	assert.deepEqual(await response.json(), { error: "R2_OPERATION_FAILED" });
});

test("CLI requires an explicit existing snapshot ID and always defaults to the isolated target", () => {
	assert.equal(parseArgs(["restore", "--id", "test"]).target, "mailflare-restore-test");
	assert.equal(parseArgs(["backup"]).url, "http://127.0.0.1:8799");
	assert.throws(() => parseArgs(["restore"]), /--id/);
	assert.throws(() => parseArgs(["restore", "--id", "test", "--target", "mailflare-raw"]), /cannot be restore targets/);
	for (const url of ["https://127.0.0.1", "http://example.com", "http://token@localhost", "http://localhost/path"]) {
		assert.throws(() => parseArgs(["backup", "--url", url]), /loopback/);
	}
});

test("actual local workerd R2 supports the stream/checksum/conditional/metadata restore flow", async t => {
	// workerd's disk binding cannot write blobs under some Windows sandbox Temp paths.
	const stateRoot = join(scriptDir, "../..", ".wrangler");
	mkdirSync(stateRoot, { recursive: true });
	const statePath = mkdtempSync(join(stateRoot, "r2-test-"));
	const mf = new Miniflare({
		resourcePersistencePath: statePath, unsafeEnableSharedStorage: false,
		telemetry: { enabled: false },
		workers: [{ config: {
			name: "r2-snapshot-test", compatibilityDate: "2026-10-03", compatibilityFlags: ["nodejs_compat"],
			manifest: { mainModule: "worker.mjs", modules: { "worker.mjs": { type: "esm", contents: readFileSync(outfile, "utf8") } } },
			env: {
				SOURCE: { type: "r2", name: "source" }, BACKUP: { type: "r2", name: "backup" }, TARGET: { type: "r2", name: "isolated-target" },
				SOURCE_BUCKET_NAME: { type: "text", value: "mailflare-raw" }, BACKUP_BUCKET_NAME: { type: "text", value: "mailflare-backups" },
				TARGET_BUCKET_NAME: { type: "text", value: "mailflare-restore-test" },
			},
		} }],
	});
	t.after(async () => { await mf.dispose(); rmSync(statePath, { recursive: true, force: true }); });
	const source = await mf.getR2Bucket("SOURCE");
	await source.put("inbound/原始.eml", Uint8Array.of(0, 1, 255, 128), {
		httpMetadata: { contentType: "message/rfc822", cacheExpiry: new Date("2030-01-01T00:00:00Z") }, customMetadata: { from: "sender@example.com" },
	});
	await source.put("empty", new Uint8Array());
	const call = async command => {
		const response = await mf.dispatchFetch(`http://127.0.0.1/${command}`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "native", target: "mailflare-restore-test" }),
		});
		return { status: response.status, result: await response.json() };
	};
	assert.deepEqual((await call("backup")).result.status, "completed");
	assert.equal((await call("backup")).result.error, "SNAPSHOT_ALREADY_EXISTS");
	const restored = await call("restore");
	assert.equal(restored.status, 200, JSON.stringify(restored.result));
	assert.equal(restored.result.objectCount, 2);
	assert.equal(restored.result.verified, true);
	assert.equal((await call("verify")).result.verified, true);
	const target = await mf.getR2Bucket("TARGET");
	const object = await target.get("inbound/原始.eml");
	assert.deepEqual(new Uint8Array(await object.arrayBuffer()), Uint8Array.of(0, 1, 255, 128));
	assert.equal(object.httpMetadata.cacheExpiry.toISOString(), "2030-01-01T00:00:00.000Z");
	assert.deepEqual(object.customMetadata, { from: "sender@example.com" });
	assert.equal((await call("restore")).result.error, "RESTORE_TARGET_NOT_EMPTY");
});
