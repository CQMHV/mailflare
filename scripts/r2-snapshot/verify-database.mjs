import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const identifier = name => `"${name.replaceAll('"', '""')}"`;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
let backupModule;

class VerificationError extends Error {
	constructor(code) { super(code); this.code = code; }
}

// This adapter deliberately has no Worker, Queue, Email or remote Cloudflare connection.
export function createD1Shim(sqlite) {
	return {
		prepare(sql) {
			let bindings = [];
			const statement = {
				bind(...values) { bindings = values; return statement; },
				async all() { return { results: sqlite.prepare(sql).all(...bindings) }; },
				async first() { return sqlite.prepare(sql).get(...bindings) ?? null; },
				async run() { return sqlite.prepare(sql).run(...bindings); },
			};
			return statement;
		},
		async batch(statements) {
			sqlite.exec("BEGIN");
			try {
				for (const statement of statements) await statement.run();
				sqlite.exec("COMMIT");
			} catch (error) { sqlite.exec("ROLLBACK"); throw error; }
		},
	};
}

export function applyMigrations(sqlite) {
	const migrationDir = join(root, "drizzle/migrations");
	const names = readdirSync(migrationDir).filter(name => /^\d{4}.*\.sql$/.test(name)).sort();
	if (!names.length) throw new VerificationError("NO_MIGRATIONS_FOUND");
	const hash = createHash("sha256");
	sqlite.exec("PRAGMA foreign_keys = ON");
	for (const name of names) {
		const content = readFileSync(join(migrationDir, name));
		hash.update(name).update("\0").update(content).update("\0");
		sqlite.exec(content.toString("utf8"));
	}
	sqlite.exec("PRAGMA foreign_keys = ON");
	return { count: names.length, last: names.at(-1), sha256: hash.digest("hex") };
}

export function loadBackupModule() {
	backupModule ??= build({
		entryPoints: [join(root, "src/lib/backups/export.ts")], bundle: true, write: false,
		platform: "node", format: "esm", target: "node24", tsconfig: join(root, "tsconfig.json"), logLevel: "silent",
	}).then(result => import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`));
	return backupModule;
}

function parseJson(bytes, errorCode) {
	try { return JSON.parse(bytes.toString("utf8")); } catch { throw new VerificationError(errorCode); }
}

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function validateBackup(document) {
	if (!object(document) || document.format !== "mailflare-database-backup" || document.version !== 1 || !object(document.tables)) {
		throw new VerificationError("INVALID_DATABASE_BACKUP");
	}
	if (document.includedTables !== undefined && (!Array.isArray(document.includedTables) || !document.includedTables.length ||
		new Set(document.includedTables).size !== document.includedTables.length ||
		document.includedTables.some(table => typeof table !== "string" || !Array.isArray(document.tables[table])))) {
		throw new VerificationError("INVALID_INCLUDED_TABLES");
	}
}

function manifestKeys(manifest) {
	if (!object(manifest) || manifest.format !== "mailflare-r2-snapshot" || manifest.version !== 1 ||
		manifest.status !== "completed" || typeof manifest.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(manifest.id) ||
		!Array.isArray(manifest.objects)) throw new VerificationError("INVALID_OR_INCOMPLETE_R2_MANIFEST");
	const keys = new Set();
	for (const entry of manifest.objects) {
		if (!object(entry) || typeof entry.key !== "string" || keys.has(entry.key) ||
			entry.snapshotKey !== `snapshots/${manifest.id}/objects/${sha256(Buffer.from(entry.key, "utf8"))}` ||
			!Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
			throw new VerificationError("INVALID_R2_MANIFEST_OBJECT");
		}
		keys.add(entry.key);
	}
	return keys;
}

function referenceReport(sqlite, tables, keys) {
	const columns = [];
	const allReferences = new Set();
	const allMissing = new Set();
	function check(table, column, values) {
		let missing = 0;
		for (const key of values) {
			if (typeof key !== "string") throw new VerificationError("INVALID_R2_REFERENCE");
			allReferences.add(key);
			if (!keys.has(key)) { missing++; allMissing.add(key); }
		}
		columns.push({ table, column, references: values.length, missing });
	}
	for (const table of tables) {
		for (const { name } of sqlite.prepare(`PRAGMA table_info(${identifier(table)})`).all()) {
			if (!/^(?:raw_)?r2_key$|^(?:avatar|icon)_key$/.test(name)) continue;
			const rows = sqlite.prepare(`SELECT ${identifier(name)} AS object_key FROM ${identifier(table)} WHERE ${identifier(name)} IS NOT NULL AND ${identifier(name)} <> ''`).all();
			check(table, name, rows.map(row => row.object_key));
		}
	}
	// Drive content uses this deterministic key when a legacy file row has no explicit r2_key.
	if (tables.has("drive_items")) {
		const rows = sqlite.prepare("SELECT owner_id, id FROM drive_items WHERE kind = 'file' AND (r2_key IS NULL OR r2_key = '')").all();
		check("drive_items", "derived_file_key", rows.map(row => `drive/${row.owner_id}/${row.id}`));
	}
	return {
		columns, uniqueReferences: allReferences.size, uniqueMissing: allMissing.size,
		missingKeysSha256: sha256(JSON.stringify([...allMissing].sort())),
		incompleteDriveUploads: tables.has("drive_items") ? sqlite.prepare("SELECT COUNT(*) AS count FROM drive_items WHERE upload_id IS NOT NULL").get().count : 0,
	};
}

async function fileHash(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

export async function verifyDatabaseBackup({ backupPath, manifestPath, outputDir }) {
	let backupBytes, manifestBytes;
	try {
		backupBytes = readFileSync(resolve(backupPath));
		manifestBytes = readFileSync(resolve(manifestPath));
	} catch { throw new VerificationError("INPUT_FILE_READ_FAILED"); }
	const document = parseJson(backupBytes, "INVALID_DATABASE_BACKUP_JSON");
	const manifest = parseJson(manifestBytes, "INVALID_R2_MANIFEST_JSON");
	validateBackup(document);
	const keys = manifestKeys(manifest);
	const directory = resolve(outputDir);
	try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
		throw new VerificationError(error.code === "EEXIST" ? "OUTPUT_DIRECTORY_ALREADY_EXISTS" : "OUTPUT_DIRECTORY_CREATE_FAILED");
	}
	const sqlitePath = join(directory, "restored.sqlite");
	const report = {
		format: "mailflare-local-database-verification", version: 1, verified: false,
		createdAt: new Date().toISOString(), inputs: { backupSha256: sha256(backupBytes), manifestSha256: sha256(manifestBytes) },
		snapshotId: manifest.id, manifestObjectCount: keys.size,
	};
	let sqlite;
	let phase = "DATABASE_CREATE_FAILED";
	try {
		// wx guarantees an existing SQLite file can never be opened for restoration by this tool.
		closeSync(openSync(sqlitePath, "wx", 0o600));
		sqlite = new DatabaseSync(sqlitePath);
		phase = "MIGRATION_FAILED";
		report.migrations = applyMigrations(sqlite);
		const db = createD1Shim(sqlite);
		phase = "BACKUP_MODULE_LOAD_FAILED";
		const { assertBackupTablesCoverDatabase, restoreDatabaseRecords } = await loadBackupModule();
		phase = "BACKUP_SCHEMA_COVERAGE_FAILED";
		const tables = await assertBackupTablesCoverDatabase(db);
		for (const name of Object.keys(document.tables)) {
			if (!tables.has(name) && name !== "message_bodies") throw new VerificationError("UNKNOWN_BACKUP_TABLE");
		}
		const included = document.includedTables ?? Object.keys(document.tables).filter(table => tables.has(table));
		if (included.some(table => !tables.has(table))) throw new VerificationError("UNKNOWN_INCLUDED_TABLE");
		phase = "DATABASE_RESTORE_FAILED";
		await restoreDatabaseRecords(db, backupBytes.buffer.slice(backupBytes.byteOffset, backupBytes.byteOffset + backupBytes.byteLength));
		phase = "DATABASE_CHECK_FAILED";
		report.foreignKeysEnabled = sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys === 1;
		const foreignKeys = sqlite.prepare("PRAGMA foreign_key_check").all();
		report.foreignKeyViolationCount = foreignKeys.length;
		report.integrityOk = sqlite.prepare("PRAGMA integrity_check").all().every(row => row.integrity_check === "ok");
		report.includedTableCounts = included.map(table => ({
			table, expected: document.tables[table].length,
			restored: sqlite.prepare(`SELECT COUNT(*) AS count FROM ${identifier(table)}`).get().count,
		}));
		report.rowCountMismatchCount = report.includedTableCounts.filter(table => table.expected !== table.restored).length;
		report.currentTablesNotIncluded = [...tables].filter(table => !included.includes(table));
		report.r2References = referenceReport(sqlite, tables, keys);
		report.verified = report.foreignKeysEnabled && !foreignKeys.length && report.integrityOk &&
			!report.rowCountMismatchCount && !report.r2References.uniqueMissing;
	} catch (error) {
		// No SQLite/JSON exception text, row values, object keys, password hashes or session tokens escape.
		report.error = error instanceof VerificationError ? error.code : phase;
	} finally {
		try { sqlite?.close(); } catch { report.error = "DATABASE_CLOSE_FAILED"; report.verified = false; }
	}
	try { report.sqliteSha256 = await fileHash(sqlitePath); } catch { report.error = "DATABASE_HASH_FAILED"; report.verified = false; }
	try { writeFileSync(join(directory, "verification-report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 }); }
	catch { throw new VerificationError("REPORT_WRITE_FAILED"); }
	return report;
}

const usage = "Usage: node scripts/r2-snapshot/verify-database.mjs --backup PATH --manifest PATH --out NEW_DIRECTORY";
export function parseArgs(args) {
	if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
	const options = {};
	for (let i = 0; i < args.length; i += 2) {
		const flag = args[i];
		if (!["--backup", "--manifest", "--out"].includes(flag) || !args[i + 1] || options[flag] !== undefined) throw new VerificationError("INVALID_ARGUMENTS");
		options[flag] = args[i + 1];
	}
	if (!["--backup", "--manifest", "--out"].every(flag => options[flag])) throw new VerificationError("INVALID_ARGUMENTS");
	return { backupPath: options["--backup"], manifestPath: options["--manifest"], outputDir: options["--out"] };
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) { console.log(usage); return; }
	const report = await verifyDatabaseBackup(options);
	console.log(JSON.stringify(report, null, 2));
	if (!report.verified) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => {
		console.error(JSON.stringify({ verified: false, error: error instanceof VerificationError ? error.code : "DATABASE_VERIFICATION_FAILED" }));
		process.exitCode = 1;
	});
}
