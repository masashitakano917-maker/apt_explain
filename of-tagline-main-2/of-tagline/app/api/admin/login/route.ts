// app/api/admin/login/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function POST(req: Request) {
  try {
    const { pin } = await req.json().catch(() => ({}));
    const ok = !!pin && pin === process.env.ADMIN_PIN;
    if (!ok) {
      return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });
    }
    cookies().set("adm", "1", {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 60 * 60 * 8, // 8時間
    });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "server error" }, { status: 500 });
  }
}
