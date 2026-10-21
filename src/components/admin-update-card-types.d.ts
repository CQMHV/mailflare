export interface MigrationStatusResponse {
	applied?: string[];
	error?: string;
	pending: string[];
	ready: boolean;
	unknown: string[];
}
