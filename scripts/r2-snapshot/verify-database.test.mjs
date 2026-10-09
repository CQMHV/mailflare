import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { applyMigrations, createD1Shim, loadBackupModule, parseArgs, verifyDatabaseBackup } from "./verify-database.mjs";

const directory = mkdtempSync(join(tmpdir(), "mailflare-database-verify-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const { exportDatabaseRecords } = await loadBackupModule();
const digest = value => createHash("sha256").update(value).digest("hex");
const privateKeys = ["avatars/private-user", "mailbox-avatars/private-mailbox", "contact-avatars/private-contact", "branding/app-icon",
	"inbound/private-original.eml", "attachments/private-message/private-attachment/file.bin", "drive/u/file", "drive/u/legacy",
	"backups/database/private-backup/records.json"];
const privateValues = [...privateKeys, "private-password-hash", "private-session-token", "PRIVATE-MESSAGE-CONTENT", "private@example.com"];

async function fixture(name) {
	const dir = join(directory, name);
	mkdirSync(dir);
	const source = new DatabaseSync(":memory:");
	let bytes;
	try {
		applyMigrations(source);
		source.exec(`
			INSERT INTO users (id,email,password_hash,name,avatar_key,created_at) VALUES ('u','private@example.com','private-password-hash','PRIVATE','avatars/private-user',1);
			INSERT INTO domains (id,user_id,hostname,zone_id,created_at) VALUES ('d','u','example.com','zone',1);
			INSERT INTO mailboxes (id,user_id,domain_id,local_part,avatar_key,created_at) VALUES ('m','u','d','private','mailbox-avatars/private-mailbox',1);
			INSERT INTO contacts (id,user_id,email,avatar_key,created_at) VALUES ('contact','u','contact@example.com','contact-avatars/private-contact',1);
			INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,raw_r2_key,status,created_at)
			VALUES ('msg','u','m','inbound','sender@example.com','private@example.com','PRIVATE','PRIVATE-MESSAGE-CONTENT','inbound/private-original.eml','received',1);
			INSERT INTO message_attachments (id,message_id,filename,content_type,size,r2_key,created_at)
			VALUES ('attachment','msg','file.bin','application/octet-stream',4,'attachments/private-message/private-attachment/file.bin',1);
			INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES ('session','u','private-session-token',2000000000,1);
			INSERT INTO push_subscriptions (id,user_id,session_id,endpoint,p256dh,auth,created_at,updated_at)
			VALUES ('push','u','session','https://push.example.com','key','auth',1,1);
			UPDATE app_settings SET icon_key='branding/app-icon';
			INSERT INTO drive_items (id,owner_id,kind,name,r2_key,created_at,updated_at) VALUES ('file','u','file','file.bin','drive/u/file',1,1);
			INSERT INTO drive_items (id,owner_id,kind,name,created_at,updated_at) VALUES ('legacy','u','file','legacy.bin',1,1);
			INSERT INTO drive_items (id,owner_id,kind,name,created_at,updated_at) VALUES ('folder','u','folder','folder',1,1);
			INSERT INTO drive_shares (id,item_id,user_id,created_at) VALUES ('share','file','u',1);
			INSERT INTO backups (id,status,trigger,r2_key,created_at) VALUES ('historical','completed','manual','backups/database/private-backup/records.json',1);
		`);
		bytes = await exportDatabaseRecords(createD1Shim(source));
	} finally { source.close(); }
	const document = JSON.parse(new TextDecoder().decode(bytes));
	const manifest = {
		format: "mailflare-r2-snapshot", version: 1, id: "fixture", status: "completed",
		objects: privateKeys.map(key => ({ key, snapshotKey: `snapshots/fixture/objects/${digest(key)}`, size: 0, sha256: digest("") })),
	};
	const paths = { backupPath: join(dir, "backup.json"), manifestPath: join(dir, "manifest.json"), outputDir: join(dir, "restored") };
	function save() {
		writeFileSync(paths.backupPath, JSON.stringify(document));
		writeFileSync(paths.manifestPath, JSON.stringify(manifest));
	}
	save();
	return { document, manifest, paths, save };
}

function assertPrivate(report) {
	const text = JSON.stringify(report);
	for (const value of privateValues) assert.ok(!text.includes(value), "report must not expose private row values or R2 object keys");
}

test("actual migrations and restore preserve every included table/FK and verify all explicit plus derived R2 references", async () => {
	const input = await fixture("success");
	const report = await verifyDatabaseBackup(input.paths);
	assert.equal(report.verified, true, JSON.stringify(report));
	assert.equal(report.foreignKeyViolationCount, 0);
	assert.equal(report.rowCountMismatchCount, 0);
	assert.equal(report.integrityOk, true);
	assert.equal(report.includedTableCounts.length, input.document.includedTables.length);
	for (const table of report.includedTableCounts) assert.equal(table.expected, table.restored);
	assert.equal(report.r2References.uniqueReferences, privateKeys.length);
	assert.equal(report.r2References.uniqueMissing, 0);
	assert.equal(report.r2References.columns.filter(column => column.column !== "derived_file_key").length, 8);
	assert.match(report.sqliteSha256, /^[a-f0-9]{64}$/);
	assert.equal(report.inputs.backupSha256, digest(readFileSync(input.paths.backupPath)));
	assert.deepEqual(JSON.parse(readFileSync(join(input.paths.outputDir, "verification-report.json"), "utf8")), report);
	assertPrivate(report);
	const restored = new DatabaseSync(join(input.paths.outputDir, "restored.sqlite"), { readOnly: true });
	try {
		assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM drive_items").get().count, 3);
		assert.equal(restored.prepare("SELECT raw_r2_key FROM messages").get().raw_r2_key, privateKeys[4]);
	} finally { restored.close(); }
});

test("missing MIME and attachment keys fail with counts and a digest, never original key text", async () => {
	const input = await fixture("missing");
	input.manifest.objects = input.manifest.objects.filter(entry => ![privateKeys[4], privateKeys[5]].includes(entry.key));
	input.save();
	const report = await verifyDatabaseBackup(input.paths);
	assert.equal(report.verified, false);
	assert.equal(report.r2References.uniqueMissing, 2);
	assert.equal(report.r2References.columns.find(column => column.table === "messages").missing, 1);
	assert.equal(report.r2References.columns.find(column => column.table === "message_attachments").missing, 1);
	assert.equal(report.r2References.missingKeysSha256, digest(JSON.stringify([privateKeys[4], privateKeys[5]].sort())));
	assertPrivate(report);
});

test("an existing output directory/SQLite is refused without overwriting any content", async () => {
	const input = await fixture("existing");
	mkdirSync(input.paths.outputDir);
	const path = join(input.paths.outputDir, "restored.sqlite");
	writeFileSync(path, "do-not-change");
	await assert.rejects(verifyDatabaseBackup(input.paths), /OUTPUT_DIRECTORY_ALREADY_EXISTS/);
	assert.equal(readFileSync(path, "utf8"), "do-not-change");
	assert.equal(existsSync(join(input.paths.outputDir, "verification-report.json")), false);
});

test("a noncompleted snapshot is rejected before creating the output directory", async () => {
	const input = await fixture("incomplete");
	input.manifest.status = "in_progress";
	input.save();
	await assert.rejects(verifyDatabaseBackup(input.paths), /INVALID_OR_INCOMPLETE_R2_MANIFEST/);
	assert.equal(existsSync(input.paths.outputDir), false);
});

test("foreign key failures return a sanitized failure report instead of a successful restoration", async () => {
	const input = await fixture("foreign-key");
	input.document.tables.messages[0].user_id = "nonexistent-user";
	input.save();
	const report = await verifyDatabaseBackup(input.paths);
	assert.equal(report.verified, false);
	assert.equal(report.error, "DATABASE_RESTORE_FAILED");
	assertPrivate(report);
});

test("unknown tables cannot be silently ignored, and older full backups remain verifiable", async () => {
	const unknown = await fixture("unknown");
	unknown.document.tables.unknown_table = [{ content: "PRIVATE-MESSAGE-CONTENT" }];
	unknown.save();
	const failed = await verifyDatabaseBackup(unknown.paths);
	assert.equal(failed.verified, false);
	assert.equal(failed.error, "UNKNOWN_BACKUP_TABLE");
	assertPrivate(failed);
	const legacy = await fixture("legacy");
	const newTables = ["push_subscriptions", "drive_items", "drive_upload_parts", "drive_shares"];
	for (const table of newTables) delete legacy.document.tables[table];
	legacy.document.includedTables = legacy.document.includedTables.filter(table => !newTables.includes(table));
	legacy.save();
	const report = await verifyDatabaseBackup(legacy.paths);
	assert.equal(report.verified, true, JSON.stringify(report));
	assert.deepEqual(report.currentTablesNotIncluded.sort(), newTables.sort());
	assertPrivate(report);
});

test("CLI requires the JSON, manifest and new output directory paths", () => {
	assert.deepEqual(parseArgs(["--backup", "a.json", "--manifest", "m.json", "--out", "new-dir"]), {
		backupPath: "a.json", manifestPath: "m.json", outputDir: "new-dir",
	});
	assert.throws(() => parseArgs(["--backup", "a.json"]), /INVALID_ARGUMENTS/);
	assert.throws(() => parseArgs(["--backup", "a.json", "--manifest", "m.json", "--out", "dir", "--out", "dir2"]), /INVALID_ARGUMENTS/);
});
