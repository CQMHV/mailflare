"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleX, Database } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
	applyDatabaseMigrations,
	getMigrationStatus,
} from "./admin-update-card-utils";
import type { MigrationStatusResponse } from "./admin-update-card-types";

export function AdminUpdateCard() {
	const { t } = useLanguage();
	const [migrationError, setMigrationError] = useState("");
	const [migrationStatus, setMigrationStatus] = useState<MigrationStatusResponse>();
	const [isCheckingMigrations, setIsCheckingMigrations] = useState(true);
	const [isMigrating, setIsMigrating] = useState(false);

	useEffect(() => {
		let isActive = true;

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

	return (
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="flex-row items-center gap-4 space-y-0 py-0">
				<div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-700">
					<Database className="h-5 w-5" />
				</div>
				<div>
					<CardTitle className="text-base">{t("update.updateDatabase")}</CardTitle>
				</div>
			</CardHeader>
			<CardContent className="space-y-5 pt-5">
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
