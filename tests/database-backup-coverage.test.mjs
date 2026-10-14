import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-backup-coverage-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/backups/export.ts")],
	outfile: join(outDir, "backup.mjs"), bundle: true, platform: "node", format: "esm",
	target: "node24", tsconfig: join(root, "tsconfig.json"), logLevel: "silent",
});
const { assertBackupTablesCoverDatabase, exportDatabaseRecords, restoreDatabaseRecords } = await import(pathToFileURL(join(outDir, "backup.mjs")).href);
const addedTables = ["push_subscriptions", "drive_items", "drive_upload_parts", "drive_shares"];

function database(t, lastMigration = "9999") {
	const sqlite = new DatabaseSync(":memory:");
	t.after(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = ON");
	const migrationDir = join(root, "drizzle/migrations");
	for (const name of readdirSync(migrationDir).filter(name => name.endsWith(".sql") && name.slice(0, 4) <= lastMigration).sort()) {
		sqlite.exec(readFileSync(join(migrationDir, name), "utf8"));
	}
	const db = {
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
	return { sqlite, db };
}

function seed(sqlite, { drive = true, push = true } = {}) {
	sqlite.exec(`
		INSERT INTO users (id,email,password_hash,name,created_at) VALUES ('u','cqmhv@example.com','hash','CQMHV',1);
		INSERT INTO domains (id,user_id,hostname,zone_id,created_at) VALUES ('d','u','example.com','zone',1);
		INSERT INTO mailboxes (id,user_id,domain_id,local_part,display_name,created_at) VALUES ('m','u','d','cqmhv','CQMHV',1);
		INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,raw_r2_key,status,created_at)
		VALUES ('msg','u','m','inbound','sender@example.net','cqmhv@example.com','Hello','Mail body','inbound/raw.eml','received',1);
		INSERT INTO message_attachments (id,message_id,filename,content_type,size,r2_key,created_at)
		VALUES ('att','msg','file.txt','text/plain',4,'attachments/msg/att/file.txt',1);
		INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES ('session','u','token',2000000000,1);
	`);
	if (push) sqlite.exec(`INSERT INTO push_subscriptions (id,user_id,session_id,endpoint,p256dh,auth,created_at,updated_at) VALUES ('push','u','session','https://push.example.net','public','secret',1,1)`);
	if (drive) sqlite.exec(`
		INSERT INTO drive_items (id,owner_id,kind,name,r2_key,created_at,updated_at) VALUES ('file','u','file','file.txt','drive/u/file',1,1);
		INSERT INTO drive_upload_parts (item_id,part_number,etag) VALUES ('file',1,'etag');
		INSERT INTO drive_shares (id,item_id,user_id,created_at) VALUES ('share','file','u',1);
	`);
}

function content(document) {
	return new TextEncoder().encode(JSON.stringify(document)).buffer;
}

test("every actual migration table is covered, and current data restores with foreign keys enabled", async t => {
	const { sqlite, db } = database(t);
	seed(sqlite);
	await assertBackupTablesCoverDatabase(db);
	const backup = await exportDatabaseRecords(db);
	const document = JSON.parse(new TextDecoder().decode(backup));
	for (const table of document.includedTables) {
		for (const foreignKey of sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
			if (foreignKey.table === table || !document.includedTables.includes(foreignKey.table)) continue;
			assert.ok(document.includedTables.indexOf(foreignKey.table) < document.includedTables.indexOf(table), `${foreignKey.table} must be restored before ${table}`);
		}
	}
	for (const table of addedTables) assert.equal(document.tables[table].length, 1, table);
	await restoreDatabaseRecords(db, backup.buffer);
	assert.equal(sqlite.prepare("SELECT text_body FROM messages WHERE id='msg'").get().text_body, "Mail body");
	assert.equal(sqlite.prepare("SELECT r2_key FROM message_attachments WHERE id='att'").get().r2_key, "attachments/msg/att/file.txt");
	for (const table of addedTables) assert.equal(sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 1, table);
	assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("pre-push and pre-drive schemas still export and restore without selecting absent tables", async t => {
	for (const lastMigration of ["0053", "0054"]) {
		const { sqlite, db } = database(t, lastMigration);
		seed(sqlite, { drive: false, push: lastMigration === "0054" });
		const backup = await exportDatabaseRecords(db);
		const document = JSON.parse(new TextDecoder().decode(backup));
		for (const table of ["drive_items", "drive_upload_parts", "drive_shares"]) assert.deepEqual(document.tables[table], []);
		await restoreDatabaseRecords(db, backup.buffer);
		assert.equal(sqlite.prepare("SELECT count(*) AS count FROM messages").get().count, 1);
		assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
	}
});

test("an older full backup missing the newly covered tables remains restorable", async t => {
	const { sqlite, db } = database(t);
	seed(sqlite);
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(db)));
	for (const table of addedTables) delete document.tables[table];
	document.includedTables = document.includedTables.filter(table => !addedTables.includes(table));
	await restoreDatabaseRecords(db, content(document));
	assert.equal(sqlite.prepare("SELECT count(*) AS count FROM users").get().count, 1);
	assert.equal(sqlite.prepare("SELECT count(*) AS count FROM messages").get().count, 1);
	for (const table of addedTables) assert.equal(sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0, table);
	delete document.includedTables;
	await restoreDatabaseRecords(db, content(document));
	assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("restoring nonempty drive data to an older schema fails before deleting its existing records", async t => {
	const source = database(t);
	seed(source.sqlite);
	const backup = await exportDatabaseRecords(source.db);
	const target = database(t, "0054");
	seed(target.sqlite, { drive: false });
	await assert.rejects(restoreDatabaseRecords(target.db, backup.buffer), /Apply pending database migrations before restoring drive_items/);
	assert.equal(target.sqlite.prepare("SELECT count(*) AS count FROM users").get().count, 1);
	assert.equal(target.sqlite.prepare("SELECT count(*) AS count FROM messages").get().count, 1);
});

test("an unregistered persistent table causes export to fail instead of silently omitting data", async t => {
	const { sqlite, db } = database(t);
	sqlite.exec("CREATE TABLE unregistered_data (id TEXT)");
	await assert.rejects(exportDatabaseRecords(db), /unregistered_data not listed in BACKUP_TABLES/);
});

test("account deletion columns preserve both pre-0063 backups and current restoration state", async t => {
	const older = database(t, "0062");
	seed(older.sqlite);
	const olderBackup = await exportDatabaseRecords(older.db);
	const current = database(t);
	seed(current.sqlite);
	await restoreDatabaseRecords(current.db, olderBackup.buffer);
	assert.deepEqual({ ...current.sqlite.prepare("SELECT disabled,last_sign_in_at,deleted_at FROM users WHERE id='u'").get() },
		{ disabled: 0, last_sign_in_at: null, deleted_at: null });
	current.sqlite.exec("UPDATE users SET disabled=1,last_sign_in_at=100,deleted_at=200 WHERE id='u'");
	const currentBackup = await exportDatabaseRecords(current.db);
	await restoreDatabaseRecords(current.db, currentBackup.buffer);
	assert.deepEqual({ ...current.sqlite.prepare("SELECT disabled,last_sign_in_at,deleted_at FROM users WHERE id='u'").get() },
		{ disabled: 1, last_sign_in_at: 100, deleted_at: 200 });
	assert.deepEqual(current.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});
