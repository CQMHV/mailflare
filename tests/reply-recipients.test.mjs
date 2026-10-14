import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-reply-recipients-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { getReplyRecipients } from "./src/components/message-actions/utils.ts";
			export { parseRawMime } from "./src/lib/email/parse.ts";
		`,
		resolveDir: root,
		sourcefile: "reply-recipients-entry.ts",
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
const { getReplyRecipients, parseRawMime } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const own = ["hello@example.com"];
const inbound = (fields) => ({
	direction: "inbound",
	fromAddr: "Website <no-reply@example.com>",
	toAddr: "hello@example.com",
	ccAddr: null,
	replyTo: null,
	providerMessageId: null,
	references: null,
	threadId: null,
	...fields,
});

test("a reply answers the sender when there is no Reply-To", () => {
	assert.deepEqual(getReplyRecipients(inbound({}), own, "reply"), { to: ["Website <no-reply@example.com>"], cc: [] });
});

test("a reply goes to every Reply-To address instead of the sender", () => {
	const message = inbound({ replyTo: "Visitor <visitor@example.net>, other@example.org" });
	assert.deepEqual(getReplyRecipients(message, own, "reply"), { to: ["Visitor <visitor@example.net>", "other@example.org"], cc: [] });
});

test("reply-all keeps the other recipients but not the From the Reply-To replaced", () => {
	const message = inbound({ replyTo: "visitor@example.net", toAddr: "hello@example.com, team@example.org", ccAddr: "boss@example.org" });
	assert.deepEqual(getReplyRecipients(message, own, "replyAll"), { to: ["visitor@example.net"], cc: ["team@example.org", "boss@example.org"] });
});

test("a Reply-To naming only the mailbox itself falls back to the sender", () => {
	const message = inbound({ replyTo: "hello@example.com" });
	assert.deepEqual(getReplyRecipients(message, own, "reply").to, ["Website <no-reply@example.com>"]);
});

test("the parser keeps the full Reply-To header", async () => {
	const raw = new TextEncoder().encode([
		"From: Website <no-reply@example.com>",
		"To: hello@example.com",
		"Reply-To: Visitor <visitor@example.net>, other@example.org",
		"Subject: Enquiry",
		"",
		"Hi",
	].join("\r\n")).buffer;
	assert.equal((await parseRawMime(raw)).replyTo, '"Visitor" <visitor@example.net>, other@example.org');
});
