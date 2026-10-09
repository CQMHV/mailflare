import { createHash, randomUUID } from "node:crypto";

export interface SnapshotEnv {
	SOURCE: R2Bucket;
	BACKUP: R2Bucket;
	TARGET: R2Bucket;
	SOURCE_BUCKET_NAME: string;
	BACKUP_BUCKET_NAME: string;
	TARGET_BUCKET_NAME: string;
}

type HttpMetadata = Omit<R2HTTPMetadata, "cacheExpiry"> & { cacheExpiry?: string };
type SnapshotObject = {
	key: string;
	snapshotKey: string;
	size: number;
	sha256: string;
	httpMetadata: HttpMetadata;
	customMetadata: Record<string, string>;
	sourceVersion: string;
	sourceUploaded: string;
};
export type SnapshotManifest = {
	format: "mailflare-r2-snapshot";
	version: 1;
	id: string;
	sourceBucket: string;
	createdAt: string;
	completedAt?: string;
	status: "in_progress" | "completed" | "failed";
	objects: SnapshotObject[];
	error?: string;
};

const MAX_PUT_BYTES = 5 * 1024 ** 3 - 5 * 1024 ** 2;
const MANIFEST_WRITE_INTERVAL_MS = 1100;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/;
const HTTP_FIELDS = ["contentType", "contentLanguage", "contentDisposition", "contentEncoding", "cacheControl"] as const;
let busy = false;

class SnapshotError extends Error {
	constructor(public code: string, public status = 409) { super(code); }
}

function assertId(id: unknown): asserts id is string {
	if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new SnapshotError("INVALID_SNAPSHOT_ID", 400);
}

export function manifestKey(id: string) {
	assertId(id);
	return `snapshots/${id}/manifest.json`;
}

function objectKey(id: string, key: string) {
	return `snapshots/${id}/objects/${createHash("sha256").update(key, "utf8").digest("hex")}`;
}

function metadata(value: R2HTTPMetadata): HttpMetadata {
	const result: HttpMetadata = {};
	for (const field of HTTP_FIELDS) {
		if (value[field] !== undefined) result[field] = value[field];
	}
	if (value.cacheExpiry) result.cacheExpiry = value.cacheExpiry.toISOString();
	return result;
}

function nativeMetadata(value: HttpMetadata): R2HTTPMetadata {
	const { cacheExpiry, ...rest } = value;
	return cacheExpiry ? { ...rest, cacheExpiry: new Date(cacheExpiry) } : rest;
}

function sameMetadata(a: Record<string, unknown>, b: Record<string, unknown>) {
	const keys = Object.keys(a).sort();
	return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

async function hashBody(body: ReadableStream<Uint8Array>) {
	const hash = createHash("sha256");
	const reader = body.getReader();
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			hash.update(value);
		}
	} finally { reader.releaseLock(); }
	const digest = hash.digest();
	return { digest, sha256: Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join(""), size };
}

async function getBody(bucket: R2Bucket, key: string, expected?: R2Object): Promise<R2ObjectBody> {
	const object = await bucket.get(key, expected ? { onlyIf: { etagMatches: expected.etag } } : undefined);
	if (!object || !("body" in object) || !object.body) throw new SnapshotError("OBJECT_MISSING_OR_CHANGED");
	if (expected && (object.version !== expected.version || object.size !== expected.size)) {
		await object.body.cancel();
		throw new SnapshotError("OBJECT_CHANGED");
	}
	return object;
}

async function inventory(bucket: R2Bucket) {
	const objects: R2Object[] = [];
	let cursor: string | undefined;
	const seenCursors = new Set<string>();
	for (;;) {
		const page = await bucket.list({ limit: 1000, cursor, include: ["httpMetadata", "customMetadata"] });
		objects.push(...page.objects);
		if (!page.truncated) return objects;
		if (!page.cursor || seenCursors.has(page.cursor)) throw new SnapshotError("INVALID_LIST_CURSOR");
		seenCursors.add(page.cursor);
		cursor = page.cursor;
	}
}

function assertBuckets(env: SnapshotEnv) {
	if (!env.SOURCE || !env.BACKUP || !env.SOURCE_BUCKET_NAME || !env.BACKUP_BUCKET_NAME ||
		env.SOURCE_BUCKET_NAME === env.BACKUP_BUCKET_NAME) throw new SnapshotError("INVALID_BUCKET_CONFIG", 400);
}

function assertTarget(env: SnapshotEnv, targetName: unknown) {
	assertBuckets(env);
	if (!env.TARGET || !env.TARGET_BUCKET_NAME || targetName !== env.TARGET_BUCKET_NAME ||
		[env.SOURCE_BUCKET_NAME, env.BACKUP_BUCKET_NAME, "mailflare-raw", "mailflare-backups"].includes(env.TARGET_BUCKET_NAME)) {
		throw new SnapshotError("UNSAFE_RESTORE_TARGET", 400);
	}
}

async function checkObject(bucket: R2Bucket, key: string, expected: SnapshotObject) {
	const object = await getBody(bucket, key);
	const hashed = await hashBody(object.body);
	if (object.size !== expected.size || hashed.size !== expected.size || hashed.sha256 !== expected.sha256) {
		throw new SnapshotError("OBJECT_CHECKSUM_MISMATCH");
	}
	if (!sameMetadata(metadata(object.httpMetadata ?? {}), expected.httpMetadata) ||
		!sameMetadata(object.customMetadata ?? {}, expected.customMetadata)) throw new SnapshotError("OBJECT_METADATA_MISMATCH");
	return object;
}

const createOnly = () => new Headers({ "If-None-Match": "*" });

export async function backup(env: SnapshotEnv, id = `${new Date().toISOString().replace(/[^0-9]/g, "")}-${randomUUID()}`) {
	assertBuckets(env);
	assertId(id);
	const key = manifestKey(id);
	const manifest: SnapshotManifest = {
		format: "mailflare-r2-snapshot", version: 1, id, sourceBucket: env.SOURCE_BUCKET_NAME,
		createdAt: new Date().toISOString(), status: "in_progress", objects: [],
	};
	const claimed = await env.BACKUP.put(key, JSON.stringify(manifest), {
		httpMetadata: { contentType: "application/json" }, onlyIf: createOnly(),
	});
	if (!claimed) throw new SnapshotError("SNAPSHOT_ALREADY_EXISTS");
	const claimedEtag = claimed.etag;
	let lastManifestWrite = performance.now();
	async function replaceManifest() {
		// R2 permits one write per second to the same key, including an empty/very small snapshot.
		const delay = MANIFEST_WRITE_INTERVAL_MS - (performance.now() - lastManifestWrite);
		if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
		lastManifestWrite = performance.now();
		return env.BACKUP.put(key, JSON.stringify(manifest), {
			httpMetadata: { contentType: "application/json" }, onlyIf: { etagMatches: claimedEtag },
		});
	}
	try {
		const objects = await inventory(env.SOURCE);
		for (const source of objects) {
			if (source.size > MAX_PUT_BYTES) throw new SnapshotError("OBJECT_EXCEEDS_SINGLE_PUT_LIMIT");
			const first = await getBody(env.SOURCE, source.key, source);
			const hashed = await hashBody(first.body);
			if (hashed.size !== source.size) throw new SnapshotError("OBJECT_SIZE_MISMATCH");
			const entry: SnapshotObject = {
				key: source.key, snapshotKey: objectKey(id, source.key), size: hashed.size, sha256: hashed.sha256,
				httpMetadata: metadata(first.httpMetadata ?? {}), customMetadata: first.customMetadata ?? {},
				sourceVersion: first.version, sourceUploaded: first.uploaded.toISOString(),
			};
			// R2's original body retains its known length. The second conditional read avoids buffering an object.
			const second = await getBody(env.SOURCE, source.key, first);
			const stored = await env.BACKUP.put(entry.snapshotKey, second.body, {
				httpMetadata: nativeMetadata(entry.httpMetadata), customMetadata: entry.customMetadata,
				sha256: hashed.digest, onlyIf: createOnly(),
			});
			if (!stored) throw new SnapshotError("SNAPSHOT_OBJECT_ALREADY_EXISTS");
			await checkObject(env.BACKUP, entry.snapshotKey, entry);
			manifest.objects.push(entry);
		}
		manifest.status = "completed";
		manifest.completedAt = new Date().toISOString();
		const completed = await replaceManifest();
		if (!completed) throw new SnapshotError("MANIFEST_CHANGED");
		return manifest;
	} catch (error) {
		manifest.status = "failed";
		delete manifest.completedAt;
		// Never persist raw provider error messages: they can contain credentials or request headers.
		manifest.error = error instanceof SnapshotError ? error.code : "R2_OPERATION_FAILED";
		try {
			await replaceManifest();
		} catch { /* A failed status write leaves in_progress, which is also never restorable. */ }
		throw new SnapshotError(manifest.error);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateManifest(value: unknown, id: string): asserts value is SnapshotManifest {
	if (!isRecord(value) || value.format !== "mailflare-r2-snapshot" || value.version !== 1 || value.id !== id ||
		!["completed", "failed", "in_progress"].includes(String(value.status)) || !Array.isArray(value.objects) ||
		typeof value.sourceBucket !== "string" || typeof value.createdAt !== "string") throw new SnapshotError("INVALID_MANIFEST");
	const keys = new Set<string>();
	for (const entry of value.objects) {
		if (!isRecord(entry) || typeof entry.key !== "string" || keys.has(entry.key) ||
			entry.snapshotKey !== objectKey(id, entry.key) || typeof entry.size !== "number" ||
			!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_PUT_BYTES ||
			typeof entry.sha256 !== "string" || !SHA_PATTERN.test(entry.sha256) ||
			!isRecord(entry.httpMetadata) || !isRecord(entry.customMetadata) ||
			Object.entries(entry.httpMetadata).some(([key, value]) =>
				(!HTTP_FIELDS.includes(key as typeof HTTP_FIELDS[number]) && key !== "cacheExpiry") || typeof value !== "string") ||
			Object.values(entry.customMetadata).some(value => typeof value !== "string") ||
			(entry.httpMetadata.cacheExpiry !== undefined && !Number.isFinite(Date.parse(String(entry.httpMetadata.cacheExpiry))))) {
			throw new SnapshotError("INVALID_MANIFEST_OBJECT");
		}
		keys.add(entry.key);
	}
	if (value.status === "completed" && (typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt)))) {
		throw new SnapshotError("INVALID_MANIFEST");
	}
}

export async function readManifest(env: SnapshotEnv, id: string) {
	assertBuckets(env);
	assertId(id);
	const object = await getBody(env.BACKUP, manifestKey(id));
	let manifest: unknown;
	try { manifest = await object.json(); } catch { throw new SnapshotError("INVALID_MANIFEST"); }
	validateManifest(manifest, id);
	return manifest;
}

async function completedManifest(env: SnapshotEnv, id: string) {
	const manifest = await readManifest(env, id);
	if (manifest.status !== "completed") throw new SnapshotError("SNAPSHOT_NOT_COMPLETED");
	return manifest;
}

export async function restore(env: SnapshotEnv, id: string, targetName: string) {
	assertTarget(env, targetName);
	const manifest = await completedManifest(env, id);
	const existing = await env.TARGET.list({ limit: 1 });
	if (existing.objects.length || existing.truncated) throw new SnapshotError("RESTORE_TARGET_NOT_EMPTY");
	// No delete or overwrite path exists. A failure may leave a partial isolated target for inspection.
	for (const entry of manifest.objects) {
		const checked = await checkObject(env.BACKUP, entry.snapshotKey, entry);
		const source = await getBody(env.BACKUP, entry.snapshotKey, checked);
		const stored = await env.TARGET.put(entry.key, source.body, {
			httpMetadata: nativeMetadata(entry.httpMetadata), customMetadata: entry.customMetadata,
			sha256: Uint8Array.from(entry.sha256.match(/../g)!, byte => parseInt(byte, 16)), onlyIf: createOnly(),
		});
		if (!stored) throw new SnapshotError("RESTORE_OBJECT_ALREADY_EXISTS");
		await checkObject(env.TARGET, entry.key, entry);
	}
	return { ...await verify(env, id, targetName), restored: true };
}

export async function verify(env: SnapshotEnv, id: string, targetName: string) {
	assertTarget(env, targetName);
	const manifest = await completedManifest(env, id);
	const actual = await inventory(env.TARGET);
	const expectedKeys = new Set(manifest.objects.map(object => object.key));
	if (actual.length !== expectedKeys.size || actual.some(object => !expectedKeys.has(object.key))) {
		throw new SnapshotError("RESTORE_INVENTORY_MISMATCH");
	}
	for (const entry of manifest.objects) await checkObject(env.TARGET, entry.key, entry);
	return { id, target: targetName, verified: true, objectCount: manifest.objects.length,
		totalBytes: manifest.objects.reduce((sum, object) => sum + object.size, 0) };
}

function summary(manifest: SnapshotManifest) {
	return { id: manifest.id, status: manifest.status, sourceBucket: manifest.sourceBucket,
		createdAt: manifest.createdAt, completedAt: manifest.completedAt, error: manifest.error,
		manifestKey: manifestKey(manifest.id), objectCount: manifest.objects.length,
		totalBytes: manifest.objects.reduce((sum, object) => sum + object.size, 0) };
}

const worker = {
	async fetch(request: Request, env: SnapshotEnv) {
		const url = new URL(request.url);
		if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || request.headers.has("Origin")) {
			return Response.json({ error: "LOCAL_CLI_ONLY" }, { status: 403 });
		}
		if (request.method !== "POST" || request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
			return Response.json({ error: "POST_JSON_REQUIRED" }, { status: 405 });
		}
		if (busy) return Response.json({ error: "OPERATION_IN_PROGRESS" }, { status: 409 });
		busy = true;
		try {
			const body: unknown = await request.json();
			if (!isRecord(body)) throw new SnapshotError("INVALID_REQUEST", 400);
			if (url.pathname === "/backup") {
				if (body.id !== undefined) assertId(body.id);
				return Response.json(summary(await backup(env, body.id as string | undefined)));
			}
			assertId(body.id);
			if (url.pathname === "/inspect") return Response.json(summary(await readManifest(env, body.id)));
			if (url.pathname === "/restore") return Response.json(await restore(env, body.id, String(body.target)));
			if (url.pathname === "/verify") return Response.json(await verify(env, body.id, String(body.target)));
			throw new SnapshotError("UNKNOWN_COMMAND", 404);
		} catch (error) {
			return Response.json({ error: error instanceof SnapshotError ? error.code : "R2_OPERATION_FAILED" },
				{ status: error instanceof SnapshotError ? error.status : 500 });
		} finally { busy = false; }
	},
};

export default worker;
