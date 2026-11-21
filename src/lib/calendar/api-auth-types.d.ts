import type { NextResponse } from "next/server";
import type { SessionUser } from "@/lib/auth/types";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";

export type CalendarAuthorization =
	| { user: SessionUser; key: ApiAuthResult | null; error: null }
	| { user: null; key: null; error: NextResponse };
