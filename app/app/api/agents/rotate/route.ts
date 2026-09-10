import { NextResponse } from "next/server";
import { POOL_ADDRESS } from "@/lib/constants";
import {
  createCircleClient,
  executeContractAndWait,
  readCircleEnv,
} from "@/lib/circle-fund";
import { log } from "@/lib/logger";
import { orchestratorBaseUrl, readCurrentRound } from "@/lib/pool-state";
import type { RotateResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const DEFAULT_TARGET = "10000000";
const DEFAULT_DURATION_SEC = "3600";
const DEFAULT_MAX_PARTICIPANTS = "4";
const MAX_DURATION_SEC = 7200n;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

/** Server-side app key only — never a NEXT_PUBLIC_ value. */
function appKey(): string | undefined {
  const key =
    process.env["ORCHESTRATOR_APP_KEY"] ?? process.env["APP_KEY"];
  return key !== undefined && key !== "" ? key : undefined;
}

/**
 * POST /api/agents/rotate — close the terminal round and open the next
 * one so judges can re-run the demo on the same pool ("Free pool").
 * Settled rounds skip straight to `startRound`; expired-unfilled rounds
 * run `finalizeExpired` first (an already-finalized round is tolerated).
 * An open, fundable round is refused with 409 — the contract itself
 * forbids closing it early, so the response names the deadline instead.
 * `startRound` is provider-only: CIRCLE_PROVIDER_WALLET_ID must be the
 * pool's provider wallet. Missing env yields 503, never a throw.
 */
export async function POST(req: Request): Promise<NextResponse<RotateResponse>> {
  const env = readCircleEnv();
  if (!env.ok) {
    return NextResponse.json({ ok: false, error: env.error }, { status: 503 });
  }
  const providerWalletId = process.env["CIRCLE_PROVIDER_WALLET_ID"] ?? "";
  if (providerWalletId === "") {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Missing CIRCLE_PROVIDER_WALLET_ID. Set it to the Circle wallet id " +
          "whose address is the pool provider (startRound is provider-only).",
      },
      { status: 503 },
    );
  }

  let requested: Record<string, unknown> = {};
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed === "object" && parsed !== null) {
      requested = parsed as Record<string, unknown>;
    }
  } catch {
    requested = {};
  }
  const target =
    requested["target"] === undefined
      ? BigInt(DEFAULT_TARGET)
      : parsePositiveBigInt(requested["target"]);
  const duration =
    requested["durationSec"] === undefined
      ? BigInt(DEFAULT_DURATION_SEC)
      : parsePositiveBigInt(requested["durationSec"]);
  const maxParticipants =
    requested["maxParticipants"] === undefined
      ? BigInt(DEFAULT_MAX_PARTICIPANTS)
      : parsePositiveBigInt(requested["maxParticipants"]);
  if (target === null || duration === null || maxParticipants === null) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Invalid round params: target/durationSec/maxParticipants must be positive decimal strings.",
      },
      { status: 400 },
    );
  }
  if (duration > MAX_DURATION_SEC) {
    return NextResponse.json(
      { ok: false, error: "Invalid round params: durationSec exceeds 7200 (2h contract cap)." },
      { status: 400 },
    );
  }

  const round = await readCurrentRound();
  const closedRoundId = round.view.roundId;
  if (closedRoundId === "0") {
    return NextResponse.json(
      { ok: false, error: "Pool has no rounds (v1 contract): deploy the v2 pool first." },
      { status: 400 },
    );
  }
  log("info", "agents.rotate.start", {
    route: "POST /api/agents/rotate",
    closedRoundId,
    pool: POOL_ADDRESS,
  });
  if (!round.view.settled && !round.view.expired) {
    const iso = new Date(Number(round.view.deadline) * 1000).toISOString();
    return NextResponse.json(
      {
        ok: false,
        error:
          `Round ${closedRoundId} is still open (fundable until ${iso}). ` +
          "Free pool unlocks once it settles or expires.",
      },
      { status: 409 },
    );
  }

  const client = createCircleClient(env.apiKey, env.entitySecret);
  try {
    let finalizeTxHash: string | null = null;
    if (!round.view.settled) {
      const finalized = await executeContractAndWait(client, {
        walletId: env.walletIds[0] ?? providerWalletId,
        contractAddress: POOL_ADDRESS,
        abiFunctionSignature: "finalizeExpired(uint256)",
        abiParameters: [closedRoundId],
      });
      if (finalized.ok) {
        finalizeTxHash = finalized.txHash;
      } else if (!/finalized/i.test(finalized.error)) {
        return NextResponse.json(
          { ok: false, error: `finalize failed: ${finalized.error}` },
          { status: 500 },
        );
      }
    }

    const started = await executeContractAndWait(client, {
      walletId: providerWalletId,
      contractAddress: POOL_ADDRESS,
      abiFunctionSignature: "startRound(uint256,uint64,uint256)",
      abiParameters: [target.toString(), duration.toString(), maxParticipants.toString()],
    });
    if (!started.ok) {
      return NextResponse.json(
        {
          ok: false,
          error:
            `startRound failed (is CIRCLE_PROVIDER_WALLET_ID the pool provider?): ${started.error}`,
        },
        { status: 500 },
      );
    }
    const fresh = await readCurrentRound();
    const newRoundId = fresh.view.roundId;
    log("info", "agents.rotate.complete", {
      route: "POST /api/agents/rotate",
      closedRoundId,
      newRoundId,
    });
    try {
      const base = orchestratorBaseUrl();
      const key = appKey();
      const upstream = await fetch(`${base}/free-pool`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key === undefined
            ? {}
            : { authorization: `Bearer ${key}`, "x-app-key": key }),
        },
        body: "{}",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      if (!upstream.ok) {
        log("warn", "agents.rotate.free_pool_bad_upstream", {
          route: "POST /api/agents/rotate",
          status: upstream.status,
          closedRoundId,
          newRoundId,
        });
      } else {
        log("info", "agents.rotate.free_pool_complete", {
          route: "POST /api/agents/rotate",
          closedRoundId,
          newRoundId,
        });
      }
    } catch (error) {
      log("warn", "agents.rotate.free_pool_unreachable", {
        route: "POST /api/agents/rotate",
        error: errorMessage(error),
        closedRoundId,
        newRoundId,
      });
    }
    return NextResponse.json({
      ok: true,
      pool: POOL_ADDRESS,
      result: {
        closedRoundId,
        newRoundId,
        finalizeTxHash,
        startRoundTxHash: started.txHash,
      },
    });
  } catch (error) {
    const body: RotateResponse = { ok: false, error: errorMessage(error) };
    return NextResponse.json(body, { status: 500 });
  }
}
