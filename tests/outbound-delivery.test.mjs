import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-outbound-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const stubs = {
	"drizzle-orm": "export const eq = (column, value) => ({ column, value }); export const and = (...values) => values; export const asc = column => column; export const inArray = (column, value) => ({ column, value });",
	"@/db": "export const getDb = env => env.__db;",
	"@/db/schema": `
		const table = (name, columns) => Object.assign({ name }, Object.fromEntries(columns.map(column => [column, { name: column }])));
		export const messages = table("messages", ["id", "status", "providerMessageId"]);
		export const outboundJobs = table("outboundJobs", ["id", "status", "payload", "messageId", "scheduledAt"]);
	`,
	"@/lib/ids": "let next = 0; export const newId = prefix => `${prefix}_${++next}`;",
	"@/lib/email/parse": "export const buildSnippet = text => text;",
	"@/lib/email/webhooks": "export const dispatchWebhooks = (env, userId, event, data) => env.__webhook(event, data);",
	"@/lib/contacts/service": "export const upsertContactFromAddress = async () => {};",
	"@/lib/email/sender": "export const getAuthorizedSenderAddress = async (env, input) => ({ fromAddr: input.from, mailboxId: input.mailboxId });",
	"@/lib/mailboxes/audit": "export const createAuditLog = env => env.__audit();",
	"@/lib/email/attachments": `
		export const validateAttachments = () => {};
		export const storeMessageAttachments = async () => [];
		export const loadMessageAttachmentContents = async env => env.__attachments;
	`,
	"@/lib/email/attachment-policy": "export const getOutboundAttachmentMaxMb = async () => 25;",
	"@/lib/email/outbound-provider": `
		export const getOutboundProviderConfig = async () => ({ provider: "cloudflare" });
		export const sendThroughProvider = (env, provider, input) => env.EMAIL.send(input);
	`,
	"@/lib/email/cloud-attachment-utils": "export const prepareCloudflareAttachments = async (env, attachments, input) => ({ attachments, html: input.html, text: input.text });",
};
await build({
	entryPoints: [join(root, "src/lib/email/send.ts")],
	outfile: join(outDir, "send.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
	plugins: [{
		name: "outbound-test-dependencies",
		setup(builder) {
			builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: "stub" } : undefined);
			builder.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: stubs[args.path], loader: "js" }));
		},
	}],
});
const { processOutboundQueue, sendEmail } = await import(pathToFileURL(join(outDir, "send.mjs")).href);

const input = {
	userId: "user_1", mailboxId: "mailbox_1", from: "me@example.com", to: "you@example.net",
	subject: "Scheduled mail", text: "Hello", inReplyTo: "<original@example.net>",
};

function fixture(options = {}) {
	const scheduledAt = options.immediate ? null : options.scheduledAt ?? new Date(Date.now() - 1000);
	const rows = {
		messages: new Map([["msg_1", { id: "msg_1", status: "queued", providerMessageId: null }]]),
		outboundJobs: new Map([["job_1", {
			id: "job_1", messageId: "msg_1", status: options.status ?? "queued", error: null,
			payload: JSON.stringify(input), scheduledAt,
		}]]),
	};
	const calls = { sends: [], notifications: [], audit: 0, enqueued: [], logs: [] };
	const failures = [...(options.writeFailures ?? [])];
	const db = {
		select(fields) {
			return { from: table => ({ where: condition => ({ limit: async () => {
				const row = rows[table.name].get(condition.value);
				return row ? [Object.fromEntries(Object.entries(fields).map(([key, column]) => [key, row[column.name]]))] : [];
			} }) }) };
		},
		update(table) {
			return { set: values => ({ where: condition => {
				const apply = async fields => {
					const terms = Array.isArray(condition) ? condition : [condition];
					const matching = [...rows[table.name].values()].filter(row => terms.every(term =>
						Array.isArray(term.value) ? term.value.includes(row[term.column.name]) : row[term.column.name] === term.value));
					const failure = failures.find(item => item.table === table.name && item.status === values.status && item.remaining > 0);
					if (failure) { failure.remaining -= 1; throw new Error(`Write failed: ${table.name}`); }
					for (const row of matching) Object.assign(row, values);
					return fields ? matching.map(row => Object.fromEntries(Object.entries(fields).map(([key, column]) => [key, row[column.name]]))) : undefined;
				};
				return { then: (resolve, reject) => apply().then(resolve, reject), returning: fields => apply(fields) };
			} }) };
		},
		insert(table) { return { values: async values => { rows[table.name].set(values.id, { ...values }); } }; },
		delete(table) { return { where: async condition => { rows[table.name].delete(condition.value); } }; },
	};
	let remainingSendFailures = options.sendFailures ?? 0;
	const transportError = new Error("Provider temporarily unavailable");
	const env = {
		__db: db,
		__attachments: options.attachments ?? [],
		EMAIL: { send: async message => {
			calls.sends.push(message);
			if (remainingSendFailures-- > 0) throw transportError;
			return { messageId: "<accepted@example.com>" };
		} },
		OUTBOUND_QUEUE: { send: async (body, options) => { calls.enqueued.push({ body, options }); } },
		__webhook: async (event, data) => {
			calls.notifications.push({ event, data });
			if (options.webhookFails) throw new Error("Webhook unavailable");
		},
		__audit: async () => {
			calls.audit += 1;
			if (options.auditFails) throw new Error("Audit unavailable");
		},
	};
	const payload = { kind: "email.scheduled", jobId: "job_1", messageId: "msg_1", scheduledAt: new Date(0).toISOString() };
	return { env, rows, calls, payload, transportError };
}

async function captureErrors(state, run) {
	const original = console.error;
	console.error = (...args) => state.calls.logs.push(args);
	try { return await run(); } finally { console.error = original; }
}

test("a failed scheduled send is retried, then becomes terminal and clears its error", async () => {
	const attachment = { filename: "hello.txt", type: "text/plain", content: new TextEncoder().encode("file").buffer };
	const state = fixture({ sendFailures: 1, attachments: [attachment] });
	await assert.rejects(processOutboundQueue(state.env, state.payload), error => error === state.transportError);
	assert.equal(state.rows.outboundJobs.get("job_1").status, "failed");
	assert.equal(state.rows.messages.get("msg_1").status, "failed");
	await processOutboundQueue(state.env, state.payload);
	await processOutboundQueue(state.env, state.payload);
	assert.equal(state.calls.sends.length, 2);
	assert.equal(state.calls.sends[1].attachments[0].filename, attachment.filename);
	assert.equal(state.calls.sends[1].headers["In-Reply-To"], "<original@example.net>");
	assert.equal(state.rows.outboundJobs.get("job_1").status, "sent");
	assert.equal(state.rows.outboundJobs.get("job_1").error, null);
	assert.equal(state.rows.messages.get("msg_1").providerMessageId, "<accepted@example.com>");
});

test("an immediate failure is returned to the caller and is never retried as scheduled work", async () => {
	const state = fixture({ sendFailures: 1 });
	await assert.rejects(sendEmail(state.env, input), error => error === state.transportError);
	const job = [...state.rows.outboundJobs.values()].find(row => row.status === "failed" && row.scheduledAt === null);
	assert.ok(job);
	assert.equal(job.scheduledAt, null);
	await processOutboundQueue(state.env, { ...state.payload, jobId: job.id, messageId: job.messageId });
	assert.equal(state.calls.sends.length, 1);
});

test("webhook and audit failures after acceptance do not fail or resend the email", async () => {
	const state = fixture({ webhookFails: true, auditFails: true });
	await captureErrors(state, () => processOutboundQueue(state.env, state.payload));
	await processOutboundQueue(state.env, state.payload);
	assert.equal(state.calls.sends.length, 1);
	assert.equal(state.rows.outboundJobs.get("job_1").status, "sent");
	assert.equal(state.rows.messages.get("msg_1").status, "sent");
	assert.deepEqual(state.calls.notifications.map(item => item.event), ["message.outbound"]);
	assert.equal(state.calls.audit, 1);
	assert.equal(state.calls.logs.length, 2);
});

test("a job write failure after acceptance is recovered from the sent message without resending", async () => {
	const state = fixture({ writeFailures: [{ table: "outboundJobs", status: "sent", remaining: 1 }] });
	await captureErrors(state, () => processOutboundQueue(state.env, state.payload));
	assert.equal(state.rows.outboundJobs.get("job_1").status, "sending");
	assert.equal(state.rows.messages.get("msg_1").status, "sent");
	await processOutboundQueue(state.env, state.payload);
	assert.equal(state.calls.sends.length, 1);
	assert.equal(state.rows.outboundJobs.get("job_1").status, "sent");
});

test("a sent-copy write failure leaves the accepted job terminal", async () => {
	const state = fixture({ writeFailures: [{ table: "messages", status: "sent", remaining: 1 }] });
	await captureErrors(state, () => processOutboundQueue(state.env, state.payload));
	assert.equal(state.rows.outboundJobs.get("job_1").status, "sent");
	await processOutboundQueue(state.env, state.payload);
	assert.equal(state.calls.sends.length, 1);
	assert.deepEqual(state.calls.notifications.map(item => item.event), ["message.outbound"]);
});

test("even total persistence failure after acceptance does not request a transport retry", async () => {
	const state = fixture({ writeFailures: [
		{ table: "outboundJobs", status: "sent", remaining: 1 },
		{ table: "messages", status: "sent", remaining: 1 },
	] });
	// A crash or later duplicate delivery remains ambiguous when neither marker
	// can be persisted; this test only covers avoiding an automatic retry now.
	await captureErrors(state, () => processOutboundQueue(state.env, state.payload));
	assert.equal(state.calls.sends.length, 1);
	assert.equal(state.calls.logs.length, 2);
	assert.deepEqual(state.calls.notifications.map(item => item.event), ["message.outbound"]);
});

test("failure notification errors preserve the provider error used for queue retry", async () => {
	const state = fixture({ sendFailures: 1, webhookFails: true });
	await captureErrors(state, async () => {
		await assert.rejects(processOutboundQueue(state.env, state.payload), error => error === state.transportError);
	});
	assert.equal(state.rows.outboundJobs.get("job_1").status, "failed");
});

test("the stored schedule is authoritative, even when a payload claims it is due", async () => {
	const state = fixture({ scheduledAt: new Date(Date.now() + 60_000) });
	await processOutboundQueue(state.env, state.payload);
	assert.equal(state.calls.sends.length, 0);
	assert.equal(state.calls.enqueued.length, 1);
	assert.equal(state.calls.enqueued[0].body.scheduledAt, state.rows.outboundJobs.get("job_1").scheduledAt.toISOString());
});

test("a payload cannot send a different message using an existing scheduled job", async () => {
	const state = fixture();
	await processOutboundQueue(state.env, { ...state.payload, messageId: "wrong_message" });
	assert.equal(state.calls.sends.length, 0);
});
