import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { SqliteDatabase } from "./helpers/d1-sqlite.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-features-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { createSession, getUserFromSession } from "./src/lib/auth/session.ts";
			export { hashPassword } from "./src/lib/auth/password.ts";
			export { generateApiKey } from "./src/lib/api-keys.ts";
			export { authenticateApiKeyValue } from "./src/lib/api/key-auth.ts";
			export { GET as accountList, POST as accountCreate } from "./src/app/api/accounts/route.ts";
			export { GET as accountDetail, PATCH as accountUpdate } from "./src/app/api/accounts/[id]/route.ts";
			export { GET as apiAccountList, POST as apiAccountCreate } from "./src/app/api/v1/accounts/route.ts";
			export { GET as apiAccountDetail, PATCH as apiAccountUpdate } from "./src/app/api/v1/accounts/[id]/route.ts";
			export { GET as brandingGet, PUT as brandingUpdate } from "./src/app/api/branding/route.ts";
			export { GET as brandingIcon } from "./src/app/api/branding/icon/route.ts";
			export { PATCH as forwardingUpdate } from "./src/app/api/settings/forwarding/route.ts";
			export { PATCH as profileUpdate } from "./src/app/api/settings/profile/route.ts";
			export { GET as authMe } from "./src/app/api/auth/me/route.ts";
			export { POST as authLogin } from "./src/app/api/auth/login/route.ts";
			export { getAccountForwardingDestination } from "./src/lib/email/account-forwarding.ts";
			export { GET as mailboxList, POST as mailboxCreate } from "./src/app/api/mailboxes/route.ts";
			export { GET as apiMailboxList, POST as apiMailboxCreate } from "./src/app/api/v1/mailboxes/route.ts";
			export { GET as apiMailboxDetail } from "./src/app/api/v1/mailboxes/[id]/route.ts";
			export { GET as accessList, POST as accessUpdate, DELETE as accessRemove } from "./src/app/api/mailboxes/[id]/access/route.ts";
			export { getMailboxAccessLevel, listAccessibleMailboxIds } from "./src/lib/mailboxes/access.ts";
			export { getMailboxNotificationUserIds } from "./src/lib/realtime/utils.ts";
			export { GET as bookingList, POST as bookingCreate } from "./src/app/api/booking/route.ts";
		`,
		resolveDir: root, sourcefile: "commercial-free-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"), bundle: true, platform: "node", format: "esm",
	target: "node24", tsconfig: join(root, "tsconfig.json"), packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const apiKeys = {
	admin: app.generateApiKey(), secondary: app.generateApiKey(), member: app.generateApiKey(),
	wrongScope: app.generateApiKey(), foreign: app.generateApiKey(),
};
const params = id => ({ params: Promise.resolve({ id }) });

class MemoryBucket {
	objects = new Map();
	async put(key, value, options) {
		const bytes = new Uint8Array(await new Response(value).arrayBuffer());
		this.objects.set(key, { bytes, httpMetadata: options?.httpMetadata });
	}
	async get(key) {
		const object = this.objects.get(key);
		return object ? { body: new Response(object.bytes).body, httpMetadata: object.httpMetadata } : null;
	}
}

async function fixture(t) {
	const database = new SqliteDatabase(":memory:", { forbidLicenseQueries: true });
	t.after(() => database.db.close());
	t.after(() => assert.equal(database.forbiddenQueries.length, 0, "runtime must never consult licensing, even when an error is swallowed"));
	await app.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id,email,password_hash,name,role,created_by_user_id,is_primary_admin,can_manage_users,can_manage_domains,can_manage_mailboxes,created_at) VALUES
			('admin','owner@one.test','hash','Owner','admin',NULL,1,1,1,1,1),
			('secondary','secondary@one.test','hash','Secondary','admin','admin',0,1,0,1,1),
			('member','member@one.test','hash','Member','user','admin',0,0,0,1,1),
			('outsider','outsider@foreign.test','hash','Outsider','user',NULL,0,0,0,0,1),
			('foreign','owner@foreign.test','hash','Foreign','admin',NULL,0,1,1,1,1),
			('foreign-member','member@foreign.test','hash','Foreign member','user','foreign',0,0,0,1,1);
		INSERT INTO domains (id,user_id,hostname,zone_id,status,created_at) VALUES
			('one','admin','one.test','manual','active',1),
			('two','admin','two.test','manual','active',1),
			('three','admin','three.test','manual','active',1),
			('foreign','foreign','foreign.test','manual','active',1);
		INSERT INTO mailboxes (id,user_id,domain_id,local_part,type,created_at) VALUES
			('admin-mail','admin','one','owner','personal',1),
			('secondary-mail','secondary','one','secondary','personal',1),
			('member-mail','member','one','member','personal',1),
			('outsider-mail','outsider','foreign','outsider','personal',1),
			('foreign-mail','foreign','foreign','owner','personal',1),
			('foreign-member-mail','foreign-member','foreign','member','personal',1),
			('shared','admin','one','support','shared',1),
			('foreign-shared','foreign','foreign','support','shared',1);
	`);
	assert.equal(database.db.prepare("SELECT count(*) AS count FROM license_settings").get().count, 0);
	const insertKey = database.db.prepare("INSERT INTO api_keys (id,user_id,name,prefix,key_hash,scopes,created_at) VALUES (?,?,?,?,?,?,1)");
	for (const [name, key] of Object.entries(apiKeys)) {
		insertKey.run(name, name === "wrongScope" ? "admin" : name, name, key.prefix, key.hash,
			JSON.stringify(name === "wrongScope" ? ["messages"] : ["accounts", "mailboxes"]));
	}
	const env = { DB: database, BUCKET: new MemoryBucket(), MAILFLARE_RUNTIME: "node", ASSETS: { fetch: async () => new Response("default icon") } };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	t.mock.method(globalThis, "fetch", async () => { throw new Error("No test may contact an external service"); });
	const sessions = {};
	for (const id of ["admin", "secondary", "member", "outsider", "foreign"]) sessions[id] = await app.createSession(env, id);
	function request(user, path, method = "GET", body, { api = false } = {}) {
		const token = api ? apiKeys[user]?.fullKey ?? user : sessions[user] ?? user;
		const headers = { Authorization: `Bearer ${token}`, Origin: "https://mailflare.test" };
		if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
		return new Request(`https://mailflare.test${path}`, {
			method, headers, ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
		});
	}
	return { database, env, db: app.getDb(env), request };
}

const accountUpdate = overrides => ({ name: "Updated member", role: "user", disabled: false, canManageMailboxes: true, ...overrides });
const accountCreate = overrides => ({ username: "new-user", domainId: "one", password: "test-password", useAllDomains: false, ...overrides });
const mailboxInput = overrides => ({ domainId: "one", localPart: "new-shared", type: "shared", ...overrides });

test("no-license account management keeps session roles and primary-admin protection", async t => {
	const f = await fixture(t);
	const list = await app.accountList(f.request("admin", "/api/accounts"));
	assert.equal(list.status, 200);
	const listing = await list.json();
	assert.equal(listing.accounts.length, 6);
	assert.equal("seats" in listing, false);
	assert.equal((await app.accountCreate(f.request("admin", "/api/accounts", "POST", accountCreate()))).status, 201);
	assert.equal((await app.accountUpdate(f.request("admin", "/api/accounts/member", "PATCH", accountUpdate({ forwardingEmail: "archive@example.net" })), params("member"))).status, 200);
	assert.equal(f.database.db.prepare("SELECT name,forwarding_email FROM users WHERE id='member'").get().forwarding_email, "archive@example.net");
	const detail = await (await app.accountDetail(f.request("admin", "/api/accounts/member"), params("member"))).json();
	assert.equal("canForwardEmail" in detail.account, false);
	assert.equal((await app.accountList(f.request("member", "/api/accounts"))).status, 403);
	assert.equal((await app.accountCreate(f.request("member", "/api/accounts", "POST", accountCreate({ username: "denied" })))).status, 403);
	assert.equal((await app.accountUpdate(f.request("member", "/api/accounts/member", "PATCH", accountUpdate()), params("member"))).status, 403);
	assert.equal((await app.accountCreate(f.request("secondary", "/api/accounts", "POST", accountCreate({ role: "admin" })))).status, 403);
	assert.equal((await app.accountUpdate(f.request("secondary", "/api/accounts/admin", "PATCH", accountUpdate({ role: "admin" })), params("admin"))).status, 403);
	assert.equal((await app.accountUpdate(f.request("secondary", "/api/accounts/member", "PATCH", accountUpdate({ role: "admin" })), params("member"))).status, 403);
	f.database.db.exec("UPDATE users SET can_manage_users=0 WHERE id='secondary'");
	assert.equal((await app.accountCreate(f.request("secondary", "/api/accounts", "POST", accountCreate({ username: "denied" })))).status, 403);
});

test("no-license admin API keeps key scope, account ownership, role and primary-admin checks", async t => {
	const f = await fixture(t);
	const req = (user, path, method, body) => f.request(user, path, method, body, { api: true });
	assert.equal((await app.apiAccountCreate(req("admin", "/api/v1/accounts", "POST", accountCreate()))).status, 201);
	assert.equal((await app.apiAccountUpdate(req("admin", "/api/v1/accounts/member", "PATCH", accountUpdate({ forwardingEmail: "api@example.net" })), params("member"))).status, 200);
	const detail = await (await app.apiAccountDetail(req("admin", "/api/v1/accounts/member"), params("member"))).json();
	assert.equal(detail.account.forwardingEmail, "api@example.net");
	assert.equal("canForwardEmail" in detail.account, false);
	for (const actor of ["invalid-key", "wrongScope", "member"]) {
		assert.equal((await app.apiAccountList(req(actor, "/api/v1/accounts"))).status, 401, actor);
		assert.equal((await app.apiAccountCreate(req(actor, "/api/v1/accounts", "POST", accountCreate({ username: "denied" })))).status, 401, actor);
	}
	assert.equal((await app.apiAccountDetail(req("admin", "/api/v1/accounts/foreign-member"), params("foreign-member"))).status, 404);
	assert.equal((await app.apiAccountUpdate(req("admin", "/api/v1/accounts/foreign-member", "PATCH", accountUpdate()), params("foreign-member"))).status, 404);
	assert.equal((await app.apiAccountDetail(req("foreign", "/api/v1/accounts/member"), params("member"))).status, 404);
	assert.equal((await app.apiAccountCreate(req("secondary", "/api/v1/accounts", "POST", accountCreate({ role: "admin" })))).status, 403);
	assert.equal((await app.apiAccountUpdate(req("secondary", "/api/v1/accounts/secondary", "PATCH", accountUpdate({ role: "admin" })), params("secondary"))).status, 403);
});

test("soft-deleted accounts cannot be re-enabled through session or API account updates", async t => {
	const f = await fixture(t);
	f.database.db.exec("UPDATE users SET deleted_at=1,disabled=1 WHERE id IN ('member','foreign-member')");
	for (const [update, api] of [[app.accountUpdate, false], [app.apiAccountUpdate, true]]) {
		const path = api ? "/api/v1/accounts/member" : "/api/accounts/member";
		const response = await update(f.request("admin", path, "PATCH", accountUpdate(), { api }), params("member"));
		assert.equal(response.status, 409);
		assert.deepEqual(await response.json(), { error: "This account is deleted. Restore it first" });
	}
	assert.deepEqual({ ...f.database.db.prepare("SELECT name,disabled,deleted_at FROM users WHERE id='member'").get() }, {
		name: "Member", disabled: 1, deleted_at: 1,
	});
	assert.equal((await app.apiAccountUpdate(
		f.request("admin", "/api/v1/accounts/foreign-member", "PATCH", accountUpdate(), { api: true }), params("foreign-member"),
	)).status, 404);
});

test("the deleted marker independently rejects password, retained sessions and API keys without licensing", async t => {
	const f = await fixture(t);
	const sessionToken = f.request("secondary", "/api/auth/me").headers.get("Authorization").slice(7);
	assert.equal((await app.authMe(f.request("secondary", "/api/auth/me"))).status, 200);
	assert.ok(await app.authenticateApiKeyValue(f.env, apiKeys.secondary.fullKey));
	const password = "deleted-account-password";
	f.database.db.prepare("UPDATE users SET password_hash=?,deleted_at=1,disabled=0 WHERE id='secondary'").run(app.hashPassword(password));
	assert.equal(await app.getUserFromSession(f.env, sessionToken), null);
	assert.equal((await app.authMe(f.request("secondary", "/api/auth/me"))).status, 401);
	assert.equal(await app.authenticateApiKeyValue(f.env, apiKeys.secondary.fullKey), null);
	assert.equal((await app.apiAccountList(f.request("secondary", "/api/v1/accounts", "GET", undefined, { api: true }))).status, 401);
	const login = await app.authLogin(f.request("secondary", "/api/auth/login", "POST", { email: "secondary@one.test", password }));
	assert.equal(login.status, 403);
	assert.deepEqual(await login.json(), { error: "Account disabled" });
	assert.equal(f.database.db.prepare("SELECT disabled,deleted_at FROM users WHERE id='secondary'").get().disabled, 0);
});

test("custom branding persists and serves its icon without a license; only primary admin may change it", async t => {
	const f = await fixture(t);
	const form = () => {
		const data = new FormData();
		data.set("appName", "CQMHV Mail");
		data.set("icon", new File([new Uint8Array([137, 80, 78, 71])], "icon.png", { type: "image/png" }));
		return data;
	};
	for (const user of ["member", "secondary", "invalid-session"]) {
		assert.equal((await app.brandingUpdate(f.request(user, "/api/branding", "PUT", form()))).status, 403, user);
	}
	assert.equal(f.env.BUCKET.objects.size, 0);
	const response = await app.brandingUpdate(f.request("admin", "/api/branding", "PUT", form()));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { appName: "CQMHV Mail", hasCustomIcon: true });
	assert.deepEqual(await (await app.brandingGet()).json(), { appName: "CQMHV Mail", hasCustomIcon: true });
	const icon = await app.brandingIcon(f.request("admin", "/api/branding/icon"));
	assert.equal(icon.headers.get("Content-Type"), "image/png");
	assert.deepEqual(new Uint8Array(await icon.arrayBuffer()), new Uint8Array([137, 80, 78, 71]));
	assert.equal(f.database.db.prepare("SELECT app_name FROM app_settings WHERE id='default'").get().app_name, "CQMHV Mail");
	const invalid = form(); invalid.set("icon", new File(["unsafe"], "icon.html", { type: "text/html" }));
	assert.equal((await app.brandingUpdate(f.request("admin", "/api/branding", "PUT", invalid))).status, 400);
});

test("ordinary users can configure their own forwarding without licensing and inbound lookup prevents loops", async t => {
	const f = await fixture(t);
	const response = await app.forwardingUpdate(f.request("member", "/api/settings/forwarding", "PATCH", { forwardingEmail: " inbox@example.net " }));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { forwardingEmail: "inbox@example.net" });
	assert.equal(await app.getAccountForwardingDestination(f.env, "member@one.test"), "inbox@example.net");
	assert.equal(await app.getAccountForwardingDestination(f.env, "missing@one.test"), null);
	assert.equal(f.database.db.prepare("SELECT forwarding_email FROM users WHERE id='admin'").get().forwarding_email, null);
	const profile = await app.profileUpdate(f.request("member", "/api/settings/profile", "PATCH", { name: "Member renamed", resetEmail: "", forwardingEmail: "MEMBER@one.test" }));
	assert.equal(profile.status, 200);
	const profileBody = await profile.json();
	assert.equal("canForwardEmail" in profileBody.user, false);
	assert.equal(await app.getAccountForwardingDestination(f.env, "member@one.test"), null);
	const me = await (await app.authMe(f.request("member", "/api/auth/me"))).json();
	assert.equal(me.user.forwardingEmail, "MEMBER@one.test");
	assert.equal("canForwardEmail" in me.user, false);
	assert.equal((await app.forwardingUpdate(f.request("member", "/api/settings/forwarding", "PATCH", { forwardingEmail: "invalid" }))).status, 400);
	await assert.rejects(app.forwardingUpdate(f.request("invalid-session", "/api/settings/forwarding", "PATCH", { forwardingEmail: "steal@example.net" })), /Unauthorized/);
	assert.equal((await app.authMe(f.request("invalid-session", "/api/auth/me"))).status, 401);
});

test("shared mailbox creation works without licensing and keeps admin, API scope and ownership boundaries", async t => {
	const f = await fixture(t);
	for (const [user, allowed] of [["admin", true], ["secondary", true], ["member", false]]) {
		const listing = await (await app.mailboxList(f.request(user, "/api/mailboxes"))).json();
		assert.equal(listing.canCreateShared, allowed, user);
	}
	assert.equal((await app.mailboxCreate(f.request("admin", "/api/mailboxes", "POST", mailboxInput()))).status, 200);
	assert.equal((await app.mailboxCreate(f.request("member", "/api/mailboxes", "POST", mailboxInput({ localPart: "denied" })))).status, 403);
	assert.equal((await app.mailboxCreate(f.request("admin", "/api/mailboxes", "POST", mailboxInput({ domainId: "foreign", localPart: "denied" })))).status, 404);
	assert.equal((await app.mailboxCreate(f.request("admin", "/api/mailboxes", "POST", mailboxInput({ type: "personal", ownerUserId: "outsider", localPart: "denied" })))).status, 404);
	const apiReq = (actor, body) => f.request(actor, "/api/v1/mailboxes", "POST", body, { api: true });
	assert.equal((await app.apiMailboxCreate(apiReq("admin", mailboxInput({ localPart: "api-shared" })))).status, 201);
	for (const actor of ["member", "wrongScope", "invalid-key"]) assert.equal((await app.apiMailboxCreate(apiReq(actor, mailboxInput({ localPart: "denied" })))).status, 401, actor);
	assert.equal((await app.apiMailboxCreate(apiReq("admin", mailboxInput({ domainId: "foreign", localPart: "denied" })))).status, 404);
	assert.equal((await app.apiMailboxCreate(apiReq("admin", mailboxInput({ type: "personal", ownerUserId: "outsider", localPart: "denied" })))).status, 404);
	assert.equal((await app.apiMailboxDetail(f.request("admin", "/api/v1/mailboxes/foreign-shared", "GET", undefined, { api: true }), params("foreign-shared"))).status, 404);
	const list = await (await app.apiMailboxList(f.request("admin", "/api/v1/mailboxes", "GET", undefined, { api: true }))).json();
	assert.ok(list.mailboxes.some(mailbox => mailbox.localPart === "api-shared"));
	assert.ok(list.mailboxes.every(mailbox => mailbox.domainId !== "foreign"));
});

test("shared ACL grants only the stored permission, without licensing or an admin-role bypass", async t => {
	const f = await fixture(t);
	const member = { id: "member", email: "member@one.test", role: "user" };
	const outsider = { id: "outsider", email: "outsider@foreign.test", role: "user" };
	const foreignAdmin = { id: "foreign", email: "owner@foreign.test", role: "admin" };
	const grant = (actor, mailbox = "shared", userId = "member", permission = "read_only") => app.accessUpdate(
		f.request(actor, `/api/mailboxes/${mailbox}/access`, "POST", { userId, permission }), params(mailbox));
	assert.equal(await app.getMailboxAccessLevel(f.db, member, "shared"), null);
	assert.equal((await grant("admin")).status, 200);
	const access = await app.getMailboxAccessLevel(f.db, member, "shared");
	assert.equal(access.canRead, true);
	assert.equal(access.canSendAs, false);
	assert.equal(access.canSendOnBehalf, false);
	assert.equal(access.canManage, false);
	assert.equal(access.isOwner, false);
	assert.ok((await app.listAccessibleMailboxIds(f.db, member)).includes("shared"));
	assert.equal(await app.getMailboxAccessLevel(f.db, outsider, "shared"), null);
	assert.equal(await app.getMailboxAccessLevel(f.db, foreignAdmin, "shared"), null);
	assert.equal(await app.getMailboxAccessLevel(f.db, member, "foreign-mail"), null);
	assert.ok(!(await app.listAccessibleMailboxIds(f.db, outsider)).includes("shared"));
	assert.deepEqual((await app.getMailboxNotificationUserIds(f.env, "shared", "admin")).sort(), ["admin", "member"]);
	const members = await (await app.accessList(f.request("admin", "/api/mailboxes/shared/access"), params("shared"))).json();
	assert.equal(members.members[0].permission, "read_only");
	assert.equal((await grant("member", "shared", "outsider", "full_access")).status, 403);
	assert.equal((await grant("admin", "foreign-shared")).status, 404);
	assert.equal((await grant("admin", "admin-mail")).status, 404);
	assert.equal((await grant("admin", "shared", "outsider")).status, 404);
	assert.equal((await grant("admin", "shared", "member", "send_as")).status, 200);
	const upgraded = await app.getMailboxAccessLevel(f.db, member, "shared");
	assert.equal(upgraded.canSendAs, true);
	assert.equal(upgraded.canManage, false);
	assert.equal((await app.accessRemove(f.request("admin", "/api/mailboxes/shared/access?userId=member", "DELETE"), params("shared"))).status, 200);
	assert.equal(await app.getMailboxAccessLevel(f.db, member, "shared"), null);
	assert.ok(!(await app.listAccessibleMailboxIds(f.db, member)).includes("shared"));
	await grant("admin", "shared", "member", "full_access");
	f.database.db.exec("UPDATE mailboxes SET disabled=1 WHERE id='shared'");
	assert.equal(await app.getMailboxAccessLevel(f.db, member, "shared"), null);
	assert.ok(!(await app.listAccessibleMailboxIds(f.db, member)).includes("shared"));
});

test("booking host management depends only on admin role while ordinary users retain their own booking", async t => {
	const f = await fixture(t);
	assert.equal((await (await app.bookingList(f.request("admin", "/api/booking"))).json()).canManageHosts, true);
	assert.equal((await (await app.bookingList(f.request("member", "/api/booking"))).json()).canManageHosts, false);
	const input = overrides => ({ name: "Consultation", slug: "consultation", description: "", location: "", durationMinutes: 30,
		weekdays: [1, 2], timeRanges: [{ startTime: "09:00", endTime: "12:00" }], timeZone: "UTC", enabled: true, hostIds: ["member"], ...overrides });
	const response = await app.bookingCreate(f.request("admin", "/api/booking", "POST", input()));
	assert.equal(response.status, 200);
	assert.deepEqual(JSON.parse((await response.json()).event.hostIds), ["admin", "member"]);
	assert.equal((await app.bookingCreate(f.request("member", "/api/booking", "POST", input({ hostIds: ["secondary"] })))).status, 400);
	assert.equal((await app.bookingCreate(f.request("member", "/api/booking", "POST", input({ hostIds: [] })))).status, 200);
	assert.equal((await app.bookingCreate(f.request("admin", "/api/booking", "POST", input({ slug: "unknown-host", hostIds: ["missing"] })))).status, 400);
	assert.equal((await app.bookingList(f.request("invalid-session", "/api/booking"))).status, 401);
});

test("retained legacy commercial data has no runtime effect and disabled sessions remain rejected", async t => {
	const f = await fixture(t);
	f.database.db.exec("INSERT INTO license_settings (id,instance_id,plan,state,seat_limit,updated_at) VALUES ('default','legacy','pro','inactive',1,1)");
	assert.equal((await app.accountCreate(f.request("admin", "/api/accounts", "POST", accountCreate()))).status, 201);
	assert.equal((await app.mailboxCreate(f.request("admin", "/api/mailboxes", "POST", mailboxInput()))).status, 200);
	assert.equal((await app.forwardingUpdate(f.request("member", "/api/settings/forwarding", "PATCH", { forwardingEmail: "archive@example.net" }))).status, 200);
	f.database.db.exec("UPDATE users SET disabled=1 WHERE id='secondary'");
	assert.equal((await app.accountList(f.request("secondary", "/api/accounts"))).status, 403);
	assert.equal((await app.authMe(f.request("secondary", "/api/auth/me"))).status, 401);
	assert.equal((await app.apiAccountList(f.request("secondary", "/api/v1/accounts", "GET", undefined, { api: true }))).status, 401);
});
