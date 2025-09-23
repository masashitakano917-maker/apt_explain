// app/api/admin/me/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function GET() {
  try {
    const isAdmin = cookies().get("adm")?.value === "1";
    return NextResponse.json({ admin: isAdmin });
  } catch (e: any) {
    return NextResponse.json({ admin: false, error: e?.message || "server error" }, { status: 500 });
  }
}
