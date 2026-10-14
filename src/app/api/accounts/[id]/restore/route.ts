import { NextResponse } from "next/server";
import { restoreAccount } from "@/lib/accounts/deletion";
import { requireAccountAdmin } from "../../utils";
import type { AccountRouteParams } from "../types";

export async function POST(request: Request, { params }: AccountRouteParams) {
	const access = await requireAccountAdmin(request);
	if (access.error) return access.error;
	const { id } = await params;
	const result = await restoreAccount(access.env, access.user!, id);
	if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
	return NextResponse.json({ ok: true });
}
