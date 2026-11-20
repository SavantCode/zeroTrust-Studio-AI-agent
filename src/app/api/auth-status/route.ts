import { NextRequest, NextResponse } from "next/server";
import {
  checkVertexDnsReachability,
  getVertexAuthHealthStatus,
} from "@/lib/config";
import { getOrCreateSession } from "@/lib/session-store";

export async function GET(req: NextRequest) {
  const reload = req.nextUrl.searchParams.get("reload") === "1";
  const { session: s } = getOrCreateSession(req, undefined, true);
  const auth = getVertexAuthHealthStatus(s?.root || null, reload);
  const dnsCheck = await checkVertexDnsReachability();

  return NextResponse.json({
    ...auth,
    dnsReachable: dnsCheck.reachable,
    dnsAddress: dnsCheck.address,
    dnsError: dnsCheck.error,
    hint: !dnsCheck.reachable
      ? `DNS lookup for oauth2.googleapis.com failed (${dnsCheck.error || "ENOTFOUND"}). Check your internet connection, VPN/firewall, or set DNS to 8.8.8.8 / 1.1.1.1.`
      : auth.hint,
  });
}