export type DeploymentState = "success" | "failure" | "running" | "queued" | "cancelled" | "skipped" | "unknown";

export interface DeploymentRecord {
	state: DeploymentState;
	commit: string;
	commitMessage: string;
	commitUrl: string;
	detailsUrl: string;
	startedAt: string | null;
	completedAt: string | null;
}

export interface DeploymentStatusResponse {
	latest: DeploymentRecord | null;
	headPending: boolean;
}
