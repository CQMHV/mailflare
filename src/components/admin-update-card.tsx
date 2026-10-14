"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleX, Database, ExternalLink, RefreshCw } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
	applyDatabaseMigrations,
	getDeploymentStatus,
	getMigrationStatus,
} from "./admin-update-card-utils";
import type { MigrationStatusResponse } from "./admin-update-card-types";
import { forkDeployment } from "@/lib/fork-deployment-config";
import type { DeploymentStatusResponse } from "@/lib/fork-deployment-types";
import packageMetadata from "../../package.json";

const { repositoryUrl, deploymentsUrl } = forkDeployment;
const deploymentLabels = {
	success: "update.deploymentSuccess",
	failure: "update.deploymentFailure",
	running: "update.deploymentRunning",
	queued: "update.deploymentQueued",
	cancelled: "update.deploymentCancelled",
	skipped: "update.deploymentSkipped",
	unknown: "update.deploymentUnknown",
} as const;

export function AdminUpdateCard() {
	const { t, locale } = useLanguage();
	const [deploymentStatus, setDeploymentStatus] = useState<DeploymentStatusResponse>();
	const [deploymentError, setDeploymentError] = useState(false);
	const [isCheckingDeployment, setIsCheckingDeployment] = useState(true);
	const [migrationError, setMigrationError] = useState("");
	const [migrationStatus, setMigrationStatus] = useState<MigrationStatusResponse>();
	const [isCheckingMigrations, setIsCheckingMigrations] = useState(true);
	const [isMigrating, setIsMigrating] = useState(false);

	useEffect(() => {
		let isActive = true;

		getDeploymentStatus()
			.then((status) => {
				if (isActive) setDeploymentStatus(status);
			})
			.catch(() => {
				if (isActive) setDeploymentError(true);
			})
			.finally(() => {
				if (isActive) setIsCheckingDeployment(false);
			});

		getMigrationStatus()
			.then((databaseStatus) => {
				if (isActive) setMigrationStatus(databaseStatus);
			})
			.catch((statusError) => {
				if (isActive) {
					setMigrationError(statusError instanceof Error ? statusError.message : t("update.migrationCheckFailed"));
				}
			})
			.finally(() => {
				if (isActive) setIsCheckingMigrations(false);
			});

		return () => {
			isActive = false;
		};
	}, []);

	async function handleRefreshDeployment() {
		setIsCheckingDeployment(true);
		setDeploymentError(false);
		try {
			setDeploymentStatus(await getDeploymentStatus());
		} catch {
			setDeploymentError(true);
		} finally {
			setIsCheckingDeployment(false);
		}
	}

	async function handleMigrate() {
		setMigrationError("");
		setIsMigrating(true);
		try {
			setMigrationStatus(await applyDatabaseMigrations());
		} catch (migrationFailure) {
			setMigrationError(
				migrationFailure instanceof Error ? migrationFailure.message : t("update.migrateFailed"),
			);
		} finally {
			setIsMigrating(false);
		}
	}

	const deployment = deploymentStatus?.latest;
	const deploymentTime = deployment?.completedAt ?? deployment?.startedAt;
	const formattedDeploymentTime = deploymentTime ? new Intl.DateTimeFormat(locale, {
		year: "numeric", month: "2-digit", day: "2-digit",
		hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
	}).format(new Date(deploymentTime)) : null;

	return (
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="flex-row items-center gap-4 space-y-0 py-0">
				<div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-700">
					<RefreshCw className="h-5 w-5" />
				</div>
				<div>
					<CardTitle className="text-base">{t("update.title")}</CardTitle>
					<p className="mt-1 text-sm text-neutral-500">
						{t("update.gitDescription")}
					</p>
				</div>
			</CardHeader>
			<CardContent className="space-y-5 pt-5">
				<div className="space-y-3 rounded-2xl border border-neutral-100 px-4 py-4">
					<p className="text-sm font-medium text-neutral-800">GitHub → Cloudflare Workers Builds</p>
					<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-neutral-600">
						<a className="font-medium text-blue-700 hover:underline" href={`${repositoryUrl}/tree/${forkDeployment.branch}`} target="_blank" rel="noreferrer">
							{forkDeployment.repository} · {forkDeployment.branch}
							<span className="sr-only"> ({t("common.opensInNewTab")})</span>
						</a>
						<span>Mailflare v{packageMetadata.version}</span>
					</div>
					<div className="space-y-3 border-t border-neutral-100 pt-3">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<p className="text-sm font-medium text-neutral-800">{t("update.latestDeployment")}</p>
							<button type="button" onClick={handleRefreshDeployment} disabled={isCheckingDeployment}
								className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:underline disabled:pointer-events-none disabled:opacity-50">
								<RefreshCw className={`h-3.5 w-3.5 ${isCheckingDeployment ? "animate-spin" : ""}`} aria-hidden="true" />
								{t("update.refreshDeployment")}
							</button>
						</div>
						{isCheckingDeployment && !deploymentStatus && <Skeleton className="h-16 w-full rounded-xl" />}
						{deploymentStatus?.headPending && deployment && (
							<p className="text-sm text-amber-700">{t("update.deploymentHeadPending")}</p>
						)}
						{deployment && (
							<div className="space-y-2 text-sm">
								<a href={deployment.detailsUrl} target="_blank" rel="noreferrer"
									className={`inline-flex items-center gap-1.5 font-medium hover:underline ${deployment.state === "success" ? "text-green-700" : deployment.state === "failure" ? "text-red-600" : "text-neutral-700"}`}>
									{t(deploymentLabels[deployment.state])}
									<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
									<span className="sr-only"> ({t("common.opensInNewTab")})</span>
								</a>
								{formattedDeploymentTime && (
									<p className="text-neutral-600">
										{t(deployment.completedAt ? "update.deploymentCompletedAt" : "update.deploymentStartedAt")}{": "}
										<time dateTime={deploymentTime ?? undefined}>{formattedDeploymentTime}</time>
									</p>
								)}
								<p className="break-words text-neutral-600">
									<a href={deployment.commitUrl} target="_blank" rel="noreferrer" className="font-mono font-medium text-blue-700 hover:underline">
										{deployment.commit.slice(0, 7)}
										<span className="sr-only"> ({t("common.opensInNewTab")})</span>
									</a>{" · "}{deployment.commitMessage}
								</p>
							</div>
						)}
						{deploymentStatus && !deployment && <p className="text-sm text-neutral-600">{t("update.noDeployment")}</p>}
						{deploymentError && <p role="alert" className="text-sm text-amber-700">{t("update.deploymentUnavailable")}</p>}
						<p className="text-xs text-neutral-500">{t("update.deploymentDelay")}</p>
					</div>
					<div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
						<a className="inline-flex items-center gap-1.5 font-medium text-blue-700 hover:underline" href={deploymentsUrl} target="_blank" rel="noreferrer">
							{t("update.viewDeployments")}
							<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
							<span className="sr-only"> ({t("common.opensInNewTab")})</span>
						</a>
						<a className="inline-flex items-center gap-1.5 font-medium text-blue-700 hover:underline" href={`${repositoryUrl}/actions/workflows/fork-checks.yml?query=branch%3Amain`} target="_blank" rel="noreferrer">
							GitHub · {t("update.viewWorkflow")}
							<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
							<span className="sr-only"> ({t("common.opensInNewTab")})</span>
						</a>
					</div>
				</div>

				{(isCheckingMigrations || migrationStatus) && (
					<div className="divide-y divide-neutral-100 overflow-hidden rounded-2xl border border-neutral-100">
						{isCheckingMigrations && (
							<div className="flex items-center gap-3 px-4 py-4">
								<Skeleton className="h-4 w-4 rounded-full" />
								<Skeleton className="h-4 w-44" />
							</div>
						)}

						{!isCheckingMigrations && !!migrationStatus?.pending.length && !migrationStatus.unknown.length && (
							<div className="flex items-center gap-3 px-4 py-4">
								<Database className={`h-4 w-4 shrink-0 text-amber-600 ${isMigrating ? "animate-pulse" : ""}`} />
								<p className="text-sm text-neutral-700">
									{t("update.pendingMigrations", { count: migrationStatus.pending.length })}
								</p>
								<button
									type="button"
									onClick={handleMigrate}
									disabled={isMigrating}
									className="ml-auto shrink-0 text-sm font-medium text-blue-700 hover:underline disabled:pointer-events-none disabled:opacity-50"
								>
									{isMigrating ? t("update.updatingDatabase") : t("update.updateDatabase")}
								</button>
							</div>
						)}

						{!isCheckingMigrations && !!migrationStatus?.unknown.length && (
							<div className="flex items-center gap-3 px-4 py-4 text-sm text-red-600">
								<CircleX className="h-4 w-4 shrink-0" />
								{t("update.deployMatching")}
							</div>
						)}

						{!isCheckingMigrations && migrationStatus?.ready && (
							<div className="flex items-center gap-3 px-4 py-4">
								<CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
								<p className="text-sm text-neutral-700">{t("update.databaseUpToDate")}</p>
							</div>
						)}
					</div>
				)}

				{migrationError && <p role="alert" className="text-sm text-red-600">{migrationError}</p>}
			</CardContent>
		</Card>
	);
}
