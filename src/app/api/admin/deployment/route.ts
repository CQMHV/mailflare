import { authorizeAdminRequest } from "@/app/api/admin/update/utils";
import { getLatestDeployment } from "@/lib/fork-deployment-status";

export async function GET(request: Request) {
	const authorization = await authorizeAdminRequest(request);
	if ("error" in authorization) return authorization.error;
	const headers = { "Cache-Control": "private, no-store" };
	try {
		return Response.json(await getLatestDeployment(), { headers });
	} catch {
		return Response.json({ error: "Could not retrieve the latest deployment status" }, { status: 502, headers });
	}
}
