import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { SqliteDatabase } from "./helpers/d1-sqlite.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(root, "node_modules", "backup-restore-test-"));
after(() => rmSync(temporary, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/backups/export.ts")],
	outfile: join(temporary, "backup.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const { BACKUP_TABLES, exportDatabaseRecords, restoreDatabaseRecords } = await import(pathToFileURL(join(temporary, "backup.mjs")).href);
const directory = join(root, "drizzle/migrations");
const migrations = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => ({
	number: Number.parseInt(name, 10),
	sql: readFileSync(join(directory, name), "utf8"),
}));
const addedTables = ["domain_tracking_hosts", "message_tracking", "message_opens", "follow_ups", "user_compose_preferences"];

function database(context, through = Infinity) {
	const db = new SqliteDatabase();
	context.after(() => db.db.close());
	for (const migration of migrations) if (migration.number <= through) db.db.exec(migration.sql);
	return db;
}

function seedMail(db) {
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user', 'user@example.test', 'hash', 'User', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('domain', 'user', 'example.test', 'zone', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox', 'user', 'domain', 'user', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, created_at)
		VALUES ('message', 'user', 'mailbox', 'outbound', 'user@example.test', 'recipient@example.test', 'Saved mail', 1);
	`);
}

const encode = (document) => new TextEncoder().encode(JSON.stringify(document)).buffer;
const decode = (content) => JSON.parse(new TextDecoder().decode(content));
const records = (db, table) => JSON.parse(JSON.stringify(db.db.prepare(`SELECT * FROM ${table}`).all()));

test("backup and restore work before the new migrations are applied", async (context) => {
	const db = database(context, 66);
	seedMail(db);
	const backup = await exportDatabaseRecords(db);
	const document = decode(backup);
	for (const table of addedTables) assert.deepEqual(document.tables[table], []);
	const before = document.tables;
	await restoreDatabaseRecords(db, backup.buffer);
	assert.deepEqual(decode(await exportDatabaseRecords(db)).tables, before);
});

for (const version of [1, 2]) {
	test(`older full format ${version} backups restore without the newly added tables`, async (context) => {
		const old = database(context, 66);
		seedMail(old);
		const document = decode(await exportDatabaseRecords(old));
		document.version = version;
		const absent = [...addedTables, ...(version === 1 ? ["drive_items", "drive_upload_parts", "drive_shares"] : [])];
		for (const table of absent) delete document.tables[table];
		document.includedTables = document.includedTables.filter((table) => !absent.includes(table));
		const restored = database(context);
		await restoreDatabaseRecords(restored, encode(document));
		for (const table of ["users", "domains", "mailboxes", "messages"]) assert.deepEqual(records(restored, table), records(old, table));
		for (const table of addedTables) assert.deepEqual(records(restored, table), []);
		assert.deepEqual(restored.db.prepare("PRAGMA foreign_key_check").all(), []);
	});
}

test("new persisted records round-trip in foreign-key order while import jobs remain internal", async (context) => {
	const db = database(context);
	seedMail(db);
	db.db.exec(`
		INSERT INTO domain_tracking_hosts (domain_id, hostname, created_at) VALUES ('domain', 'track.example.test', 1);
		INSERT INTO message_tracking (token, message_id, open_count, created_at) VALUES ('token', 'message', 1, 1);
		INSERT INTO message_opens (id, token, opened_at, automated) VALUES ('open', 'token', 2, 0);
		INSERT INTO follow_ups (id, message_id, user_id, due_at, created_at) VALUES ('follow-up', 'message', 'user', 3, 1);
		INSERT INTO user_compose_preferences (user_id, track_opens_default, undo_send_seconds, updated_at) VALUES ('user', 1, 45, 1);
		INSERT INTO import_jobs (id, user_id, mailbox_id, kind, label, spec, created_at, updated_at)
		VALUES ('job', 'user', 'mailbox', 'imap', 'Import', '{}', 1, 1);
	`);
	for (const table of BACKUP_TABLES) {
		for (const { table: parent } of db.db.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
			if (parent !== table && BACKUP_TABLES.includes(parent)) {
				assert.ok(BACKUP_TABLES.indexOf(parent) < BACKUP_TABLES.indexOf(table), `${parent} must precede ${table}`);
			}
		}
	}
	const backup = await exportDatabaseRecords(db);
	const document = decode(backup);
	assert.equal(document.includedTables.includes("import_jobs"), false);
	assert.equal("import_jobs" in document.tables, false);
	await restoreDatabaseRecords(db, backup.buffer);
	assert.deepEqual(decode(await exportDatabaseRecords(db)).tables, document.tables);
	assert.deepEqual(db.db.prepare("PRAGMA foreign_key_check").all(), []);
	assert.deepEqual(records(db, "import_jobs"), []);
});

test("users and booking events retain their existing restoration into older column sets", async (context) => {
	const current = database(context);
	seedMail(current);
	current.db.exec("INSERT INTO booking_events (id, user_id, name, slug, duration_minutes, created_at, updated_at) VALUES ('booking', 'user', 'Meeting', 'meeting', 30, 1, 1)");
	const document = decode(await exportDatabaseRecords(current));
	const target = database(context);
	target.db.exec("ALTER TABLE users DROP COLUMN keyboard_shortcuts_enabled; ALTER TABLE booking_events DROP COLUMN time_ranges");
	await restoreDatabaseRecords(target, encode(document));
	for (const [table, column] of [["users", "keyboard_shortcuts_enabled"], ["booking_events", "time_ranges"]]) {
		const expected = document.tables[table].map((row) => {
			const value = { ...row };
			delete value[column];
			return value;
		});
		assert.deepEqual(records(target, table), expected);
	}
});

for (const { through, table, column } of [
	{ through: 69, table: "app_settings", column: "spamhaus_dqs_key" },
	{ through: 72, table: "user_compose_preferences", column: "undo_send_seconds" },
]) {
	test(`missing ${table}.${column} aborts restore before any records are deleted`, async (context) => {
		const current = database(context);
		if (table === "user_compose_preferences") {
			seedMail(current);
			current.db.exec("INSERT INTO user_compose_preferences (user_id, undo_send_seconds, updated_at) VALUES ('user', 45, 1)");
		}
		const backup = await exportDatabaseRecords(current);
		const target = database(context, through);
		seedMail(target);
		const before = decode(await exportDatabaseRecords(target)).tables;
		let deletes = 0;
		const prepare = target.prepare.bind(target);
		target.prepare = (sql) => {
			if (/^DELETE\b/i.test(sql)) deletes += 1;
			return prepare(sql);
		};
		await assert.rejects(restoreDatabaseRecords(target, backup.buffer), new RegExp(`Apply pending database migrations.*${table}.*${column}`));
		assert.equal(deletes, 0);
		assert.deepEqual(decode(await exportDatabaseRecords(target)).tables, before);
	});
}

test("restoring records for an absent new table requires its migration before deleting data", async (context) => {
	const current = database(context);
	seedMail(current);
	current.db.exec("INSERT INTO message_tracking (token, message_id, created_at) VALUES ('token', 'message', 1)");
	const target = database(context, 66);
	seedMail(target);
	const before = decode(await exportDatabaseRecords(target)).tables;
	await assert.rejects(restoreDatabaseRecords(target, (await exportDatabaseRecords(current)).buffer), /Apply pending database migrations before restoring message_tracking/);
	assert.deepEqual(decode(await exportDatabaseRecords(target)).tables, before);
});
