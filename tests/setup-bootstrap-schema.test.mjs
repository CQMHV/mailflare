import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { SqliteDatabase } from "./helpers/d1-sqlite.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(tmpdir(), "mailflare-setup-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

// Execute the real generator with its only write captured in memory. The tests
// also work in a clean checkout, where the generated migration bundle is absent.
const generatorPath = join(root, "scripts/generate-migration-bundle.mjs");
const generator = await build({
	entryPoints: [generatorPath], bundle: true, platform: "node", format: "cjs", write: false,
	define: { "import.meta.url": JSON.stringify(pathToFileURL(generatorPath).href) }, logLevel: "silent",
});
let migrationBundle;
runInNewContext(generator.outputFiles[0].text, {
	URL,
	require(name) {
		assert.equal(name, "node:fs");
		return {
			readFileSync, readdirSync,
			writeFileSync(path, contents) {
				assert.equal(path.href, pathToFileURL(join(root, "src/lib/migrations/bundle.json")).href);
				assert.equal(migrationBundle, undefined, "generator should emit exactly one bundle");
				migrationBundle = contents;
			},
		};
	},
});
assert.ok(migrationBundle);
await build({
	stdin: {
		contents: `
			export { migrateCleanDatabase } from "./src/lib/setup/migration.ts";
			export { getMigrationStatus } from "./src/lib/migrations/service.ts";
			export { exportDatabaseRecords, restoreDatabaseRecords } from "./src/lib/backups/export.ts";
		`,
		resolveDir: root, sourcefile: "setup-schema-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"), bundle: true, platform: "node", format: "esm",
	target: "node24", tsconfig: join(root, "tsconfig.json"), logLevel: "silent",
	plugins: [{
		name: "in-memory-migration-bundle",
		setup(builder) {
			builder.onResolve({ filter: /^\.\/bundle\.json$/ }, args => {
				if (args.importer.replaceAll("\\", "/").endsWith("/src/lib/migrations/service.ts")) {
					return { path: "migration-bundle", namespace: "test-migrations" };
				}
			});
			builder.onLoad({ filter: /.*/, namespace: "test-migrations" }, () => ({ contents: migrationBundle, loader: "json" }));
		},
	}],
});
const { migrateCleanDatabase, getMigrationStatus, exportDatabaseRecords, restoreDatabaseRecords } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

function database(t) {
	const db = new SqliteDatabase();
	t.after(() => db.db.close());
	return db;
}

test("real bootstrap applies every committed migration once and reports a ready current schema", async t => {
	const db = database(t);
	assert.equal(await migrateCleanDatabase(db), true);
	const expected = readdirSync(join(root, "drizzle/migrations")).filter(name => name.endsWith(".sql")).sort();
	assert.deepEqual(db.db.prepare("SELECT name FROM d1_migrations ORDER BY name").all().map(row => row.name), expected);
	assert.deepEqual(await getMigrationStatus(db), { ready: true, pending: [], unknown: [] });
	assert.equal(await migrateCleanDatabase(db), false);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM d1_migrations").get().count, expected.length);
	assert.deepEqual(db.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("fresh setup accepts current mailbox data and preserves historical license rows through full backup restore", async t => {
	const db = database(t);
	await migrateCleanDatabase(db);
	db.db.exec(`
		INSERT INTO users (id,email,password_hash,name,created_at) VALUES ('u','a@example.com','hash','Member',1);
		INSERT INTO domains (id,user_id,hostname,zone_id,sending_requested,created_at) VALUES ('d','u','example.com','manual',1,1);
		INSERT INTO mailboxes (id,user_id,domain_id,local_part,display_name,signature,auto_reply_enabled,auto_reply_subject,auto_reply_body,created_at)
			VALUES ('m','u','d','a','Member','Signature',1,'Out of office','Reply body',1);
		INSERT INTO license_settings (id,instance_id,plan,state,seat_limit,updated_at) VALUES ('default','legacy-instance','pro','inactive',1,1);
		INSERT INTO auto_reply_deliveries (id,mailbox_id,recipient,sent_at) VALUES ('ar','m','sender@example.net',1);
	`);
	const bytes = await exportDatabaseRecords(db);
	const document = JSON.parse(new TextDecoder().decode(bytes));
	assert.ok(document.includedTables.includes("license_settings"));
	assert.equal(document.tables.license_settings[0].instance_id, "legacy-instance");
	const target = database(t);
	await migrateCleanDatabase(target);
	await restoreDatabaseRecords(target, bytes.buffer);
	assert.equal(target.db.prepare("SELECT instance_id FROM license_settings WHERE id='default'").get().instance_id, "legacy-instance");
	assert.equal(target.db.prepare("SELECT signature,auto_reply_body FROM mailboxes WHERE id='m'").get().auto_reply_body, "Reply body");
	assert.equal(target.db.prepare("SELECT sending_requested FROM domains WHERE id='d'").get().sending_requested, 1);
	assert.equal(target.db.prepare("SELECT count(*) AS count FROM auto_reply_deliveries").get().count, 1);
	assert.deepEqual(target.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("D1 test adapter batch rolls back all earlier writes on SQL and foreign-key failures", async t => {
	const db = database(t);
	db.db.exec("CREATE TABLE parents (id TEXT PRIMARY KEY); CREATE TABLE children (id TEXT PRIMARY KEY,parent_id TEXT REFERENCES parents(id));");
	for (const failing of [db.prepare("INSERT INTO children VALUES ('c','missing')"), db.prepare("INSERT INTO missing_table VALUES ('missing')")]) {
		await assert.rejects(db.batch([db.prepare("INSERT INTO parents VALUES ('p')"), failing]));
		assert.equal(db.db.prepare("SELECT count(*) AS count FROM parents").get().count, 0);
		assert.equal(db.db.prepare("SELECT count(*) AS count FROM children").get().count, 0);
	}
	await db.batch([db.prepare("INSERT INTO parents VALUES ('p')"), db.prepare("INSERT INTO children VALUES ('c','p')")]);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM children").get().count, 1);
	assert.deepEqual(db.db.prepare("PRAGMA foreign_key_check").all(), []);
});
