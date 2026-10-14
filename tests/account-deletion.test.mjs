import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { SqliteDatabase } from "./helpers/d1-sqlite.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(root, "drizzle/migrations");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-account-deletion-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { hashPassword } from "./src/lib/auth/password.ts";
			export { GET as accountList, DELETE as accountDelete } from "./src/app/api/accounts/route.ts";
			export { POST as accountRestore } from "./src/app/api/accounts/[id]/restore/route.ts";
			export { GET as authMe } from "./src/app/api/auth/me/route.ts";
			export { POST as login } from "./src/app/api/auth/login/route.ts";
			export { deleteAccounts, runAccountRetention } from "./src/lib/accounts/deletion.ts";
			export { processOutboundQueue } from "./src/lib/email/send.ts";
		`,
		resolveDir: root, sourcefile: "account-deletion-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"), bundle: true, platform: "node", format: "esm",
	target: "node24", tsconfig: join(root, "tsconfig.json"), packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const password = "test-password";
const passwordHash = app.hashPassword(password);
const params = id => ({ params: Promise.resolve({ id }) });
const retentionNow = new Date("2026-10-15T12:00:00Z");
const daysAgo = days => Math.floor(retentionNow.getTime() / 1000) - days * 86_400;

class MemoryBucket {
	objects = new Map();
	deleted = [];
	async delete(keys) {
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			this.deleted.push(key);
			this.objects.delete(key);
		}
	}
}

function database(t) {
	const db = new SqliteDatabase(":memory:", { forbidLicenseQueries: true });
	t.after(() => db.db.close());
	t.after(() => assert.equal(db.forbiddenQueries.length, 0, "account deletion and restore must never consult licensing, even if an error is swallowed"));
	return db;
}

async function fixture(t) {
	const db = database(t);
	await app.applyMigrations(db, migrations);
	db.db.exec(`
		INSERT INTO users (id,email,password_hash,name,role,is_primary_admin,can_manage_users,created_by_user_id,created_at) VALUES
			('primary','owner@primary.test','hash','Owner','admin',1,1,NULL,1),
			('secondary','secondary@primary.test','hash','Secondary','admin',0,1,'primary',1),
			('other-admin','other@primary.test','hash','Other admin','admin',0,1,'primary',1),
			('limited','limited@primary.test','hash','Limited admin','admin',0,0,'primary',1),
			('member','member@primary.test','hash','Member','user',0,0,'primary',1),
			('survivor','survivor@survivor.test','hash','Survivor','user',0,0,'primary',1);
		INSERT INTO domains (id,user_id,hostname,zone_id,status,receiving_provider,created_at) VALUES
			('primary-domain','primary','primary.test','manual','active','none',1),
			('survivor-domain','survivor','survivor.test','manual','active','none',1);
		INSERT INTO mailboxes (id,user_id,domain_id,local_part,type,use_all_domains,created_at) VALUES
			('member-mail','member','primary-domain','member','personal',0,1),
			('survivor-mail','survivor','survivor-domain','survivor','personal',0,1);
	`);
	db.db.prepare("UPDATE users SET password_hash=? WHERE id='member'").run(passwordHash);
	const env = { DB: db, BUCKET: new MemoryBucket(), MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const external = t.mock.method(globalThis, "fetch", async () => { throw new Error("Account deletion tests may not contact external services"); });
	t.after(() => assert.equal(external.mock.callCount(), 0, "manual-domain routing must not contact an external service"));
	const sessions = {};
	for (const id of ["primary", "secondary", "other-admin", "limited", "member", "survivor"]) sessions[id] = await app.createSession(env, id);
	function request(user, path, method = "GET", body) {
		const headers = { Authorization: `Bearer ${sessions[user] ?? user}`, Origin: "https://mailflare.test" };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		return new Request(`https://mailflare.test${path}`, {
			method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
	}
	const actor = { id: "primary", email: "owner@primary.test", role: "admin", isPrimaryAdmin: true, canManageUsers: true };
	return { database: db, env, sessions, request, actor };
}

async function remove(f, actor, ids, transferToId) {
	return app.accountDelete(f.request(actor, "/api/accounts", "DELETE", { ids, transferToId }));
}

function storedMessage(f, id, userId, mailboxId) {
	const raw = `raw/${id}.eml`;
	const attachment = `attachments/${id}/file.txt`;
	f.database.db.prepare(`INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,raw_r2_key,status,created_at)
		VALUES (?,?,?,'inbound','sender@example.net','member@primary.test','Retained message','Mail body',?,'received',1)`).run(id, userId, mailboxId, raw);
	f.database.db.prepare(`INSERT INTO message_attachments (id,message_id,filename,content_type,size,r2_key,created_at)
		VALUES (?,?,'file.txt','text/plain',4,?,1)`).run(`${id}-attachment`, id, attachment);
	f.env.BUCKET.objects.set(raw, `${id}: raw message`);
	f.env.BUCKET.objects.set(attachment, `${id}: attachment`);
	return { raw, attachment };
}

function seedMemberData(f) {
	storedMessage(f, "member-message", "member", "member-mail");
	f.database.db.exec(`
		INSERT INTO drive_items (id,owner_id,kind,name,r2_key,created_at,updated_at)
			VALUES ('member-file','member','file','file.txt','drive/member/file',1,1);
		INSERT INTO calendar_events (id,user_id,title,starts_at,ends_at,created_at,updated_at)
			VALUES ('member-event','member','Meeting',1,2,1,1);
	`);
	f.env.BUCKET.objects.set("drive/member/file", "Member file");
	f.env.BUCKET.objects.set("avatars/member", "Member avatar");
	f.database.db.prepare("UPDATE users SET deleted_at=?,disabled=1 WHERE id='member'").run(daysAgo(31));
}

function retainedState(f) {
	const tables = ["users", "domains", "mailboxes", "mailbox_aliases", "mailbox_access", "messages", "message_attachments", "outbound_jobs", "drive_items", "calendar_events", "sessions"];
	return {
		tables: Object.fromEntries(tables.map(table => [table, f.database.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])),
		objects: [...f.env.BUCKET.objects.entries()].sort(([a], [b]) => a.localeCompare(b)),
	};
}

test("0063 upgrades existing accounts with nullable deletion and sign-in timestamps, and sessions record last sign-in", async t => {
	const db = database(t);
	db.db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)");
	for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql") && name.slice(0, 4) < "0063").sort()) {
		db.db.exec(readFileSync(join(migrations, name), "utf8"));
		db.db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
	}
	db.db.exec("INSERT INTO users (id,email,password_hash,name,created_at) VALUES ('legacy','legacy@example.net','hash','Legacy account',1)");
	assert.ok(!db.db.prepare("PRAGMA table_info(users)").all().some(column => column.name === "deleted_at" || column.name === "last_sign_in_at"));
	const applied = await app.applyMigrations(db, migrations);
	assert.ok(applied.includes("0063_add_account_deletion.sql"));
	const columns = db.db.prepare("PRAGMA table_info(users)").all();
	for (const name of ["deleted_at", "last_sign_in_at"]) {
		const column = columns.find(column => column.name === name);
		assert.ok(column, name);
		assert.equal(column.type.toLowerCase(), "integer", name);
		assert.equal(column.notnull, 0, name);
		assert.equal(column.dflt_value, null, name);
	}
	const account = db.db.prepare("SELECT email,name,disabled,deleted_at,last_sign_in_at FROM users WHERE id='legacy'").get();
	assert.deepEqual({ ...account }, { email: "legacy@example.net", name: "Legacy account", disabled: 0, deleted_at: null, last_sign_in_at: null });
	const before = Math.floor(Date.now() / 1000);
	await app.createSession({ DB: db }, "legacy");
	const signIn = db.db.prepare("SELECT last_sign_in_at FROM users WHERE id='legacy'").get().last_sign_in_at;
	assert.ok(signIn >= before && signIn <= Math.floor(Date.now() / 1000));
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM sessions WHERE user_id='legacy'").get().count, 1);
	assert.deepEqual(await app.applyMigrations(db, migrations), []);
	assert.deepEqual(db.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("DELETE disables login, invalidates every session, and retains data for restoration", async t => {
	const f = await fixture(t);
	storedMessage(f, "retained-message", "member", "member-mail");
	const secondToken = await app.createSession(f.env, "member");
	assert.equal((await app.authMe(f.request("member", "/api/auth/me"))).status, 200);
	assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM sessions WHERE user_id='member'").get().count, 2);
	const before = Math.floor(Date.now() / 1000);
	const response = await remove(f, "primary", ["member", "member"]);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true, deleted: 1 });
	const account = f.database.db.prepare("SELECT disabled,deleted_at FROM users WHERE id='member'").get();
	assert.equal(account.disabled, 1);
	assert.ok(account.deleted_at >= before && account.deleted_at <= Math.floor(Date.now() / 1000));
	assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM sessions WHERE user_id='member'").get().count, 0);
	for (const token of [f.sessions.member, secondToken]) assert.equal((await app.authMe(f.request(token, "/api/auth/me"))).status, 401);
	const login = await app.login(f.request("invalid-session", "/api/auth/login", "POST", { email: "member@primary.test", password }));
	assert.equal(login.status, 403);
	assert.deepEqual(await login.json(), { error: "Account disabled" });
	assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM sessions WHERE user_id='member'").get().count, 0);
	assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM mailboxes WHERE id='member-mail'").get().count, 1);
	assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM messages WHERE id='retained-message'").get().count, 1);
	assert.equal(f.env.BUCKET.objects.size, 2);
	assert.deepEqual(f.env.BUCKET.deleted, []);
	const accounts = (await (await app.accountList(f.request("primary", "/api/accounts"))).json()).accounts;
	assert.ok(accounts.find(account => account.id === "member").deletedAt);
	assert.ok(accounts.find(account => account.id === "member").lastSignInAt);
});

test("restore works without a license and never revives revoked sessions", async t => {
	const f = await fixture(t);
	assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM license_settings").get().count, 0);
	assert.equal((await remove(f, "secondary", ["member"])).status, 200);
	const response = await app.accountRestore(f.request("secondary", "/api/accounts/member/restore", "POST"), params("member"));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
	assert.deepEqual({ ...f.database.db.prepare("SELECT disabled,deleted_at FROM users WHERE id='member'").get() }, { disabled: 0, deleted_at: null });
	assert.equal((await app.authMe(f.request("member", "/api/auth/me"))).status, 401);
	const fresh = await app.createSession(f.env, "member");
	assert.equal((await app.authMe(f.request(fresh, "/api/auth/me"))).status, 200);
	f.database.db.exec("INSERT INTO license_settings (id,instance_id,plan,state,seat_limit,updated_at) VALUES ('default','legacy','pro','inactive',1,1)");
	assert.equal((await remove(f, "primary", ["member"])).status, 200);
	assert.equal((await app.accountRestore(f.request("primary", "/api/accounts/member/restore", "POST"), params("member"))).status, 200);
	assert.equal((await app.authMe(f.request(fresh, "/api/auth/me"))).status, 401);
	assert.equal((await app.accountRestore(f.request("primary", "/api/accounts/member/restore", "POST"), params("member"))).status, 409);
	assert.equal((await app.accountRestore(f.request("primary", "/api/accounts/missing/restore", "POST"), params("missing"))).status, 404);
});

test("delete and restore protect the primary admin, self, admin roles and management capability", async t => {
	const f = await fixture(t);
	for (const [actor, ids, status] of [
		["primary", ["primary"], 400], ["secondary", ["secondary"], 400],
		["secondary", ["primary"], 403], ["secondary", ["other-admin"], 403],
		["member", ["survivor"], 403], ["limited", ["member"], 403],
		["invalid-session", ["member"], 403],
	]) assert.equal((await remove(f, actor, ids)).status, status, `${actor}: ${ids}`);
	assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM users WHERE deleted_at IS NOT NULL OR disabled=1").get().count, 0);
	assert.equal((await remove(f, "primary", ["other-admin"])).status, 200);
	for (const actor of ["secondary", "limited", "member", "invalid-session"]) {
		assert.equal((await app.accountRestore(f.request(actor, "/api/accounts/other-admin/restore", "POST"), params("other-admin"))).status, 403, actor);
	}
	assert.ok(f.database.db.prepare("SELECT deleted_at FROM users WHERE id='other-admin'").get().deleted_at);
	assert.equal((await app.accountRestore(f.request("primary", "/api/accounts/other-admin/restore", "POST"), params("other-admin"))).status, 200);
});

test("invalid bulk deletion rejects the entire selection before data transfers or session changes", async t => {
	const f = await fixture(t);
	f.database.db.exec("INSERT INTO calendar_events (id,user_id,title,starts_at,ends_at,created_at,updated_at) VALUES ('event','member','Meeting',1,2,1,1)");
	const before = retainedState(f);
	for (const [ids, transferToId, status] of [
		[[], undefined, 400], [["member", "missing"], undefined, 404],
		[["member", "primary"], "survivor", 400], [["member"], "member", 400],
	]) {
		const result = await app.deleteAccounts(f.env, f.actor, { ids, transferToId });
		assert.equal(result.ok, false);
		assert.equal(result.status, status);
		assert.deepEqual(retainedState(f), before);
	}
	assert.equal((await remove(f, "primary", ["member"])).status, 200);
	assert.equal((await remove(f, "primary", ["member"])).status, 409);
});

test("soft deletion cancels queued and failed scheduled sends without cancelling delivery already in progress or another account's jobs", async t => {
	const f = await fixture(t);
	const send = t.mock.fn(async () => { throw new Error("Cancelled scheduled jobs must not send email"); });
	f.env.EMAIL = { send };
	f.database.db.exec("UPDATE domains SET sending_provider='cloudflare' WHERE id='primary-domain'");
	const scheduledAt = Math.floor(Date.now() / 1000) - 60;
	for (const [id, userId, mailboxId, status] of [
		["queued", "member", "member-mail", "queued"],
		["failed", "member", "member-mail", "failed"],
		["sending", "member", "member-mail", "sending"],
		["survivor-queued", "survivor", "survivor-mail", "queued"],
	]) {
		const from = userId === "member" ? "member@primary.test" : "survivor@survivor.test";
		f.database.db.prepare(`INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,status,created_at)
			VALUES (?,?,?,'outbound',?,'recipient@example.net','Scheduled email','Mail body',?,1)`)
			.run(`${id}-message`, userId, mailboxId, from, status === "failed" ? "failed" : "queued");
		f.database.db.prepare(`INSERT INTO outbound_jobs (id,user_id,message_id,status,payload,scheduled_at,created_at,updated_at)
			VALUES (?,?,?,?,?,?,1,1)`)
			.run(id, userId, `${id}-message`, status, JSON.stringify({ userId, mailboxId, from, to: "recipient@example.net", subject: "Scheduled email", text: "Mail body" }), scheduledAt);
	}
	const preserved = ["sending", "survivor-queued"].map(id => f.database.db.prepare("SELECT * FROM outbound_jobs WHERE id=?").get(id));
	assert.equal((await remove(f, "primary", ["member"])).status, 200);
	for (const id of ["queued", "failed"]) {
		assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM outbound_jobs WHERE id=?").get(id).count, 0, id);
		const message = f.database.db.prepare("SELECT status,provider_message_id FROM messages WHERE id=?").get(`${id}-message`);
		assert.equal(message.status, "draft", id);
		assert.equal(message.provider_message_id, null, id);
	}
	for (const job of preserved) {
		assert.deepEqual(f.database.db.prepare("SELECT * FROM outbound_jobs WHERE id=?").get(job.id), job);
		assert.equal(f.database.db.prepare("SELECT status FROM messages WHERE id=?").get(job.message_id).status, "queued");
	}
	const afterCancellation = retainedState(f);
	for (const id of ["queued", "failed"]) {
		await app.processOutboundQueue(f.env, { kind: "email.scheduled", jobId: id, messageId: `${id}-message`, scheduledAt: new Date(scheduledAt * 1000).toISOString() });
	}
	assert.equal(send.mock.callCount(), 0, "redelivered cancelled jobs must not reach email transport");
	assert.deepEqual(retainedState(f), afterCancellation, "redelivered cancelled jobs must not modify drafts, surviving jobs or stored objects");
	assert.deepEqual(f.env.BUCKET.deleted, []);
});

test("retention defers an account whose domain is used by a surviving account's mailbox", async t => {
	const f = await fixture(t);
	seedMemberData(f);
	f.database.db.exec(`
		INSERT INTO domains (id,user_id,hostname,zone_id,status,receiving_provider,created_at)
			VALUES ('deleted-domain','member','deleted.test','manual','active','none',1);
		INSERT INTO mailboxes (id,user_id,domain_id,local_part,type,use_all_domains,created_at)
			VALUES ('survivor-cross-mail','survivor','deleted-domain','survivor','personal',0,1);
	`);
	storedMessage(f, "survivor-cross-message", "survivor", "survivor-cross-mail");
	const before = retainedState(f);
	assert.equal(await app.runAccountRetention(f.env, retentionNow), 0);
	assert.deepEqual(retainedState(f), before, "the account, domains, surviving mailbox, messages, attachments and stored objects must be retained");
	assert.deepEqual(f.env.BUCKET.deleted, [], "deferred purge must not delete any stored object");
	assert.deepEqual(f.database.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("retention defers an account whose domain supplies an alias for a surviving account's mailbox", async t => {
	const f = await fixture(t);
	seedMemberData(f);
	f.database.db.exec(`
		INSERT INTO domains (id,user_id,hostname,zone_id,status,receiving_provider,created_at)
			VALUES ('alias-domain','member','alias.test','manual','active','none',1);
		INSERT INTO mailbox_aliases (id,mailbox_id,domain_id,local_part,created_at)
			VALUES ('survivor-alias','survivor-mail','alias-domain','survivor',1);
	`);
	storedMessage(f, "alias-survivor-message", "survivor", "survivor-mail");
	const before = retainedState(f);
	assert.equal(await app.runAccountRetention(f.env, retentionNow), 0);
	assert.deepEqual(retainedState(f), before, "the alias domain, survivor alias, mailbox, messages, attachments and all stored objects must be retained");
	assert.deepEqual(f.env.BUCKET.deleted, []);
	assert.deepEqual(f.database.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("retention defers an account whose mailbox is shared with another account", async t => {
	const f = await fixture(t);
	seedMemberData(f);
	f.database.db.exec(`
		UPDATE mailboxes SET type='shared' WHERE id='member-mail';
		INSERT INTO mailbox_access (id,mailbox_id,user_id,permission,created_by_user_id,created_at)
			VALUES ('survivor-access','member-mail','survivor','read_only','primary',1);
	`);
	storedMessage(f, "shared-survivor-message", "survivor", "survivor-mail");
	const before = retainedState(f);
	assert.equal(await app.runAccountRetention(f.env, retentionNow), 0);
	assert.deepEqual(retainedState(f), before, "shared mailbox access, messages, attachments and all stored objects must survive deferred purge");
	assert.deepEqual(f.env.BUCKET.deleted, []);
	assert.deepEqual(f.database.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("retention defers an account that authored messages in a surviving owner's mailbox", async t => {
	const f = await fixture(t);
	seedMemberData(f);
	storedMessage(f, "authored-survivor-message", "member", "survivor-mail");
	const before = retainedState(f);
	assert.equal(await app.runAccountRetention(f.env, retentionNow), 0);
	assert.deepEqual(retainedState(f), before, "the surviving domain, mailbox, authored messages, attachments and stored objects must be retained");
	assert.deepEqual(f.env.BUCKET.deleted, [], "deferred purge must not delete any stored object");
	assert.deepEqual(f.database.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("retention defers a Drive folder containing another account's file", async t => {
	const f = await fixture(t);
	seedMemberData(f);
	f.database.db.exec(`
		INSERT INTO drive_items (id,owner_id,parent_id,kind,name,created_at,updated_at)
			VALUES ('member-folder','member',NULL,'folder','Shared parent',1,1);
		INSERT INTO drive_items (id,owner_id,parent_id,kind,name,r2_key,created_at,updated_at)
			VALUES ('survivor-file','survivor','member-folder','file','Survivor file.txt','drive/survivor/file',1,1);
	`);
	f.env.BUCKET.objects.set("drive/survivor/file", "Survivor file");
	storedMessage(f, "drive-survivor-message", "survivor", "survivor-mail");
	const before = retainedState(f);
	assert.equal(await app.runAccountRetention(f.env, retentionNow), 0);
	assert.deepEqual(retainedState(f), before, "the mixed-owner Drive tree and every database row and stored object must be retained");
	assert.deepEqual(f.env.BUCKET.deleted, []);
	assert.deepEqual(f.database.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("retention purges an isolated account deleted over 30 days ago and preserves active and recently deleted accounts", async t => {
	const f = await fixture(t);
	seedMemberData(f);
	const survivor = storedMessage(f, "survivor-message", "survivor", "survivor-mail");
	f.env.BUCKET.objects.set("avatars/survivor", "Survivor avatar");
	f.database.db.prepare("UPDATE users SET deleted_at=?,disabled=1 WHERE id='other-admin'").run(daysAgo(1));
	assert.equal(await app.runAccountRetention(f.env, retentionNow), 1);
	assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM users WHERE id='member'").get().count, 0);
	for (const [table, id] of [["mailboxes", "member-mail"], ["messages", "member-message"], ["message_attachments", "member-message-attachment"], ["drive_items", "member-file"], ["calendar_events", "member-event"]]) {
		assert.equal(f.database.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE id=?`).get(id).count, 0, table);
	}
	assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM sessions WHERE user_id='member'").get().count, 0);
	assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM domains").get().count, 2);
	assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM mailboxes WHERE id='survivor-mail'").get().count, 1);
	assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM messages WHERE id='survivor-message'").get().count, 1);
	assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM message_attachments WHERE id='survivor-message-attachment'").get().count, 1);
	assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM users WHERE id IN ('primary','survivor','other-admin')").get().count, 3);
	assert.deepEqual([...f.env.BUCKET.objects.keys()].sort(), [survivor.raw, survivor.attachment, "avatars/survivor"].sort());
	assert.deepEqual(f.env.BUCKET.deleted.sort(), ["raw/member-message.eml", "attachments/member-message/file.txt", "drive/member/file", "avatars/member"].sort());
	assert.deepEqual(f.database.db.prepare("PRAGMA foreign_key_check").all(), []);
	assert.equal(await app.runAccountRetention(f.env, retentionNow), 0);
});
