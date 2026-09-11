import { NextResponse } from "next/server";
import {
  createCircleClient,
  getWalletAddress,
  readCircleEnv,
} from "@/lib/circle-fund";
import {
  defaultFundUsdc,
  readTreasuryEnv,
  sendUsdcFromTreasury,
} from "@/lib/appkit";
import { log } from "@/lib/logger";
import type { TreasuryResponse, TreasurySendStep } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const USDC_DECIMAL_PATTERN = /^\d+(\.\d{1,6})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * POST /api/agents/treasury — fund Arc Testnet wallets from a Circle
 * developer-controlled treasury using Circle App Kits `kit.send` (same-chain
 * USDC). Body `{ to?, amountUsdc? }`: with `to`, sends once; without, fans out
 * to every CIRCLE_WALLET_IDS funding wallet. Funding only — App Kit cannot call
 * the pool, so /api/agents/fund's DCW approve + commit path is unchanged.
 */
export async function POST(
  request: Request,
): Promise<NextResponse<TreasuryResponse>> {
  const env = readTreasuryEnv();
  if (!env.ok) {
    return NextResponse.json({ ok: false, error: env.error }, { status: 503 });
  }
  const circleEnv = readCircleEnv();
  if (!circleEnv.ok) {
    return NextResponse.json({ ok: false, error: circleEnv.error }, { status: 503 });
  }

  let body: unknown = {};
  try {
    body = (await request.json()) as unknown;
  } catch {
    body = {};
  }
  const to =
    isRecord(body) && typeof body["to"] === "string"
      ? body["to"].trim()
      : undefined;
  if (to !== undefined && !ADDRESS_PATTERN.test(to)) {
    return NextResponse.json(
      { ok: false, error: "to must be a 0x-prefixed 20-byte address" },
      { status: 400 },
    );
  }
  const requestedAmount =
    isRecord(body) && typeof body["amountUsdc"] === "string"
      ? body["amountUsdc"].trim()
      : undefined;
  const amountUsdc = requestedAmount ?? defaultFundUsdc();
  if (!USDC_DECIMAL_PATTERN.test(amountUsdc)) {
    return NextResponse.json(
      { ok: false, error: `amountUsdc ${amountUsdc} is not a decimal USDC string` },
      { status: 400 },
    );
  }

  const client = createCircleClient(env.apiKey, env.entitySecret);
  const treasuryAddress = await getWalletAddress(client, env.treasuryWalletId);
  if (treasuryAddress === null) {
    return NextResponse.json(
      { ok: false, error: "treasury wallet address unavailable" },
      { status: 502 },
    );
  }

  let recipients: readonly string[];
  if (to !== undefined) {
    recipients = [to];
  } else {
    const resolved = await Promise.all(
      circleEnv.walletIds.map((walletId) => getWalletAddress(client, walletId)),
    );
    recipients = resolved.filter((address): address is string => address !== null);
  }
  if (recipients.length === 0) {
    return NextResponse.json(
      { ok: false, error: "no recipient wallets resolved" },
      { status: 502 },
    );
  }

  log("info", "agents.treasury.start", {
    route: "POST /api/agents/treasury",
    treasury: treasuryAddress,
    recipients: recipients.length,
    amountUsdc,
  });

  const sends: TreasurySendStep[] = [];
  for (const recipient of recipients) {
    sends.push(
      await sendUsdcFromTreasury({
        apiKey: env.apiKey,
        entitySecret: env.entitySecret,
        fromAddress: treasuryAddress,
        to: recipient,
        amountUsdc,
      }),
    );
  }

  const sent = sends.filter((step) => step.state === "success").length;
  log("info", "agents.treasury.complete", {
    route: "POST /api/agents/treasury",
    sent,
    failed: sends.length - sent,
    amountUsdc,
  });

  return NextResponse.json({
    ok: true,
    treasury: { walletId: env.treasuryWalletId, address: treasuryAddress },
    sends,
  });
}
