import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const usage = `Usage: node scripts/r2-snapshot/cli.mjs <backup|inspect|restore|verify> [--id ID] [--target NAME] [--url http://127.0.0.1:8799]
backup creates a new immutable snapshot; inspect/restore/verify require --id.
restore/verify default to the isolated local mailflare-restore-test binding.
Start the temporary local Wrangler dev process first. No token is accepted or logged.`;

export function parseArgs(args) {
	const [command, ...rest] = args;
	if (command === "--help" || command === "-h") return { help: true };
	if (!["backup", "inspect", "restore", "verify"].includes(command)) throw new Error(usage);
	const options = {};
	for (let i = 0; i < rest.length; i += 2) {
		const flag = rest[i];
		if (!["--id", "--target", "--url"].includes(flag) || !rest[i + 1] || options[flag] !== undefined) throw new Error(usage);
		options[flag] = rest[i + 1];
	}
	const url = new URL(options["--url"] ?? "http://127.0.0.1:8799");
	if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
		url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("Only an HTTP loopback URL without credentials, path, query or fragment is allowed.");
	}
	const id = options["--id"] ?? (command === "backup" ? `${new Date().toISOString().replace(/[^0-9]/g, "")}-${randomUUID()}` : undefined);
	if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id)) throw new Error("A valid --id is required.");
	const target = options["--target"] ?? "mailflare-restore-test";
	if (["mailflare-raw", "mailflare-backups"].includes(target)) throw new Error("Production and backup buckets cannot be restore targets.");
	if (options["--target"] && !["restore", "verify"].includes(command)) throw new Error("--target only applies to restore/verify.");
	return { command, url: url.origin, id, target };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) { console.log(usage); return; }
	console.log(`Snapshot ID: ${args.id}`);
	let response;
	try {
		response = await fetch(`${args.url}/${args.command}`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: args.id, target: args.target }),
		});
	} catch {
		throw new Error(`Local request failed; the result may be unknown. Inspect snapshot ${args.id} before retrying. Keep the same ID.`);
	}
	let result;
	try { result = await response.json(); } catch { throw new Error("Invalid local response; inspect the same snapshot ID before retrying."); }
	if (!response.ok) throw new Error(`Operation failed: ${typeof result.error === "string" ? result.error : "UNKNOWN_ERROR"}. Inspect the same snapshot ID before retrying.`);
	console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
