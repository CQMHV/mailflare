import type { MigrationStatusResponse } from "./admin-update-card-types";
import type { DeploymentStatusResponse } from "@/lib/fork-deployment-types";

export async function getDeploymentStatus(): Promise<DeploymentStatusResponse> {
	const response = await fetch("/api/admin/deployment", { cache: "no-store" });
	if (!response.ok) throw new Error("Could not retrieve the latest deployment status");
	return response.json();
}

export async function getMigrationStatus(): Promise<MigrationStatusResponse> {
	const response = await fetch("/api/admin/migrations", { cache: "no-store" });
	const data = (await response.json()) as MigrationStatusResponse;
	if (!response.ok) throw new Error(data.error ?? "Could not check database migrations");
	return data;
}

export async function applyDatabaseMigrations(): Promise<MigrationStatusResponse> {
	const response = await fetch("/api/admin/migrations", { method: "POST" });
	const data = (await response.json()) as MigrationStatusResponse;
	if (!response.ok) throw new Error(data.error ?? "Could not apply database migrations");
	return data;
}
