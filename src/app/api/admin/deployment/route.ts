import { authorizeAdminRequest } from "@/app/api/admin/update/utils";
import { getLatestDeployment, GitHubDeploymentHttpError } from "@/lib/fork-deployment-status";

export async function GET(request: Request) {
	const authorization = await authorizeAdminRequest(request);
	if ("error" in authorization) return authorization.error;
	const headers = { "Cache-Control": "private, no-store" };
	try {
		return Response.json(await getLatestDeployment(), { headers });
	} catch (error) {
		const name = error instanceof Error ? error.name : "Unknown";
		const code = error instanceof GitHubDeploymentHttpError ? "upstream-http"
			: ["TimeoutError", "AbortError"].includes(name) ? "upstream-timeout"
				: ["ZodError", "SyntaxError"].includes(name) ? "invalid-upstream-response" : "lookup-failed";
		const upstreamStatus = error instanceof GitHubDeploymentHttpError ? error.status : undefined;
		// Keep provider bodies, request headers and environment credentials out of diagnostics.
		console.warn("deployment-status-lookup-failed", { code, upstreamStatus, name });
		return Response.json({ error: "Could not retrieve the latest deployment status", code, upstreamStatus }, { status: 502, headers });
	}
}
