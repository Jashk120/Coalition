import { NextResponse } from "next/server";
import { erc20Abi } from "viem";
import { fromAtomicUsdc, toAtomicUsdc } from "@jx-nexus/coalition";
import {
  USDC_ADDRESS,
  createCircleClient,
  getWalletAddress,
  readCircleEnv,
} from "@/lib/circle-fund";
import {
  defaultFundUsdc,
  readTreasuryEnv,
  sendUsdcFromTreasury,
} from "@/lib/appkit";
import { arcPublicClient } from "@/lib/chain";
import { log } from "@/lib/logger";
import type { TreasuryResponse, TreasurySendStep } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const USDC_DECIMAL_PATTERN = /^\d+(\.\d{1,6})?$/;
/** Arc gas is USDC, so keep a small buffer above the target commit amount. */
const GAS_HEADROOM_ATOMIC = 100_000n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * POST /api/agents/treasury — re-fund agents for the next funding round from
 * the provider/treasury wallet via Circle App Kits `kit.send`. Each recipient
 * is topped up to `amountUsdc` (default CIRCLE_TREASURY_FUND_USDC, else 2.50)
 * only when its on-chain USDC balance is below that target; already-funded
 * wallets are skipped. Body `{ to?, amountUsdc? }`: `to` targets one wallet,
 * otherwise it fans out to every CIRCLE_WALLET_IDS funder (never the treasury
 * itself). Funding only — App Kit cannot call the pool, so the DCW approve +
 * commit path in /api/agents/fund is unchanged.
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
  const providerWalletId = process.env["CIRCLE_PROVIDER_WALLET_ID"] ?? "";
  if (providerWalletId !== "" && env.treasuryWalletId === providerWalletId) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "treasury must not be the pool provider wallet: the provider is the " +
          "settle payee and must not fund the agents that pay into the pool",
      },
      { status: 409 },
    );
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
    recipients = resolved.filter(
      (address): address is string =>
        address !== null &&
        address.toLowerCase() !== treasuryAddress.toLowerCase(),
    );
  }
  if (recipients.length === 0) {
    return NextResponse.json(
      { ok: false, error: "no recipient wallets resolved" },
      { status: 502 },
    );
  }

  const targetAtomic = toAtomicUsdc(amountUsdc) + GAS_HEADROOM_ATOMIC;
  const targetUsdc = fromAtomicUsdc(targetAtomic);
  log("info", "agents.treasury.start", {
    route: "POST /api/agents/treasury",
    treasury: treasuryAddress,
    recipients: recipients.length,
    targetUsdc,
  });

  const publicClient = arcPublicClient();
  const sends: TreasurySendStep[] = [];
  for (const recipient of recipients) {
    let balance: bigint;
    try {
      balance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [recipient as `0x${string}`],
      });
    } catch (error) {
      sends.push({
        to: recipient,
        amountUsdc: "0",
        state: "error",
        txHash: null,
        explorerUrl: null,
        error: `balance read failed: ${errorMessage(error)}`,
      });
      continue;
    }
    if (balance >= targetAtomic) {
      sends.push({
        to: recipient,
        amountUsdc: "0",
        balanceAtomic: balance.toString(),
        state: "noop",
        txHash: null,
        explorerUrl: null,
        reason: `already ${fromAtomicUsdc(balance)} >= target ${targetUsdc}`,
      });
      continue;
    }
    const step = await sendUsdcFromTreasury({
      apiKey: env.apiKey,
      entitySecret: env.entitySecret,
      fromAddress: treasuryAddress,
      to: recipient,
      amountUsdc: fromAtomicUsdc(targetAtomic - balance),
    });
    sends.push({
      ...step,
      balanceAtomic: balance.toString(),
      reason: `topped up ${fromAtomicUsdc(balance)} -> ${targetUsdc}`,
    });
  }

  const sent = sends.filter((step) => step.state === "success").length;
  const skipped = sends.filter((step) => step.state === "noop").length;
  log("info", "agents.treasury.complete", {
    route: "POST /api/agents/treasury",
    sent,
    skipped,
    failed: sends.length - sent - skipped,
    targetUsdc,
  });

  return NextResponse.json({
    ok: true,
    treasury: { walletId: env.treasuryWalletId, address: treasuryAddress },
    sends,
  });
}
