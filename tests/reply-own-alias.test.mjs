import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-reply-alias-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { createReplyDraft, getReplyRecipients, getReplyThreading, hasAdditionalRecipients } from "./src/components/message-actions/utils.ts";
			export { getOwnAddressForMessage } from "./src/app/(dashboard)/inbox/[messageId]/utils.ts";
		`,
		resolveDir: root,
		sourcefile: "reply-alias-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { createReplyDraft, getReplyRecipients, getReplyThreading, hasAdditionalRecipients, getOwnAddressForMessage } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const ownAddresses = ["cqmhv@cqmhv.com", "cqmhv@hopewritedream.com", "cqmhv@vrclearn.com"];
const incoming = {
	direction: "inbound",
	fromAddr: '"cqmhv" <cqmhv@cqmhv.com>',
	toAddr: "cqmhv@hopewritedream.com",
	ccAddr: null,
	providerMessageId: "<alias-message@example.com>",
	references: "<earlier-message@example.com>",
	threadId: "alias-thread",
};

test("replying to an incoming message from another own alias keeps its sender", () => {
	assert.equal(getOwnAddressForMessage(incoming, ownAddresses), "cqmhv@hopewritedream.com");
	assert.deepEqual(getReplyRecipients(incoming, ownAddresses, "reply"), {
		to: [incoming.fromAddr],
		cc: [],
	});
	assert.equal(hasAdditionalRecipients(incoming, ownAddresses), false);
});

test("a message sent to the same own address can also be replied to", () => {
	const message = { ...incoming, toAddr: "cqmhv@cqmhv.com" };
	assert.deepEqual(getReplyRecipients(message, ownAddresses, "reply"), {
		to: [incoming.fromAddr],
		cc: [],
	});
});

test("reply-all keeps the own sender while removing other own addresses and duplicate recipients", () => {
	const message = {
		...incoming,
		toAddr: "cqmhv@hopewritedream.com, Friend <friend@example.net>",
		ccAddr: "CQMHV@CQMHV.COM, cqmhv@vrclearn.com, FRIEND@example.net, Colleague <colleague@example.net>",
	};
	assert.deepEqual(getReplyRecipients(message, ownAddresses, "replyAll"), {
		to: [incoming.fromAddr],
		cc: ["Friend <friend@example.net>", "Colleague <colleague@example.net>"],
	});
	assert.equal(hasAdditionalRecipients(message, ownAddresses), true);
});

test("external incoming senders and outgoing recipient selection keep their existing behavior", () => {
	const message = { ...incoming, fromAddr: "Friend <friend@example.net>", ccAddr: "cqmhv@vrclearn.com, colleague@example.net" };
	assert.deepEqual(getReplyRecipients(message, ownAddresses, "reply"), { to: [message.fromAddr], cc: [] });
	assert.deepEqual(getReplyRecipients(message, ownAddresses, "replyAll"), { to: [message.fromAddr], cc: ["colleague@example.net"] });
	const outgoing = { ...message, direction: "outbound", fromAddr: incoming.fromAddr, toAddr: "friend@example.net" };
	assert.deepEqual(getReplyRecipients(outgoing, ownAddresses, "replyAll"), { to: ["friend@example.net"], cc: ["colleague@example.net"] });
});

test("the cross-domain self-message creates a reply draft with the receiving alias and original thread", async (t) => {
	const requests = [];
	t.mock.method(globalThis, "fetch", async (url, options) => {
		assert.equal(url, "/api/drafts", "the test must not contact a real service");
		assert.equal(options.method, "POST");
		requests.push(JSON.parse(options.body));
		return Response.json({ draft: { id: "reply-draft" } });
	});
	const draftId = await createReplyDraft({
		mailboxId: "mailbox-own-alias",
		senderAddress: incoming.fromAddr,
		ownAddress: getOwnAddressForMessage(incoming, ownAddresses),
		subject: "Alias delivery test",
		bodyText: "Original test message",
		sentAt: "2026-10-09T13:00:00.000Z",
		recipients: getReplyRecipients(incoming, ownAddresses, "reply"),
		threading: getReplyThreading(incoming),
	});
	assert.equal(draftId, "reply-draft");
	assert.equal(requests.length, 1);
	assert.equal(requests[0].mailboxId, "mailbox-own-alias");
	assert.equal(requests[0].from, "cqmhv@hopewritedream.com");
	assert.equal(requests[0].to, incoming.fromAddr);
	assert.equal(requests[0].cc, "");
	assert.equal(requests[0].subject, "Re: Alias delivery test");
	assert.equal(requests[0].inReplyTo, "alias-message@example.com");
	assert.equal(requests[0].references, "earlier-message@example.com alias-message@example.com");
	assert.equal(requests[0].threadId, incoming.threadId);
	assert.match(requests[0].html, /Original test message/);
});

test("a genuinely missing incoming sender remains invalid", async () => {
	const message = { ...incoming, fromAddr: "" };
	const recipients = getReplyRecipients(message, ownAddresses, "reply");
	assert.deepEqual(recipients, { to: [], cc: [] });
	await assert.rejects(createReplyDraft({ mailboxId: "mailbox", senderAddress: "", recipients }), /Sender address is required/);
});
