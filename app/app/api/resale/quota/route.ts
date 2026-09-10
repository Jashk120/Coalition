import { NextResponse } from "next/server";
import { fetchQuote } from "@jx-nexus/coalition";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import type {
  GatewayMiddleware,
  PaymentRequest,
  PaymentResponse,
} from "@circle-fin/x402-batching/server";
import {
  RESALE_FACILITATOR_URL,
  RESALE_NETWORK,
} from "@/lib/constants";
import { log } from "@/lib/logger";
import { orchestratorBaseUrl } from "@/lib/pool-state";
import { atomicToUsdcPrice } from "@/lib/resale";

export const dynamic = "force-dynamic";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Exact CU-leg cost from the JSON decimal, mirroring the orchestrator's
 * transferCost (mb*rateMB + floor(cu*rateCU) via big.Rat on the decimal
 * text): re-stringify the received float (shortest round-trip, same value
 * Go's FormatFloat 'g' sees) and floor rateCU*digits/10^fracLen in bigint.
 * Quote math itself is untouched — this only prices the middleware amount.
 */
function cuLegCost(ratePerCUAtomic: bigint, cu: number): bigint {
  const text = JSON.stringify(cu) as string;
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (match === null) throw new Error(`cu value ${text} is not a decimal`);
  const intDigits = match[1] ?? "";
  const fracDigits = match[2] ?? "";
  const exp = match[3] === undefined ? 0 : Number.parseInt(match[3], 10);
  const digits = `${intDigits}${fracDigits}`;
  const scale = fracDigits.length - exp;
  const numerator = digits === "" ? 0n : BigInt(digits);
  if (scale <= 0) return ratePerCUAtomic * numerator * 10n ** BigInt(-scale);
  return (ratePerCUAtomic * numerator) / 10n ** BigInt(scale);
}

type GateResult =
  | {
      readonly paid: true;
      readonly payer: string;
      readonly amount: string;
      readonly network: string;
      readonly transaction: string;
    }
  | {
      readonly paid: false;
      readonly status: number;
      readonly headers: Record<string, string>;
      readonly body: string;
    };

/**
 * Run the Express-style Gateway middleware inside a Next route handler.
 * The middleware either ends the response (402 payment-required, 4xx/5xx —
 * relayed verbatim so generic x402 clients keep working) or calls next()
 * after inline verify+settle, attaching req.payment {verified, payer,
 * amount, network, transaction}. Settlement extraction: transaction is the
 * Gateway settle transaction — that value is the settlementId the Go
 * /transfer-quota verifies (DOCUMENTED here, not inferred elsewhere).
 */
async function runQuotaGate(
  gateway: GatewayMiddleware,
  request: Request,
  price: string,
): Promise<GateResult> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const shimReq = {
    method: request.method,
    url: new URL(request.url).pathname,
    headers,
    body: undefined,
    payment: undefined as
      | {
          verified: boolean;
          payer: string;
          amount: string;
          network: string;
          transaction?: string;
        }
      | undefined,
  };
  let statusCode = 200;
  const outHeaders: Record<string, string> = {};
  let outBody = "";
  const shimRes = {
    statusCode,
    setHeader: (name: string, value: string | string[]): void => {
      outHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    },
    end: (body?: string): void => {
      if (body !== undefined) outBody = body;
    },
  };
  let nextCalled = false;
  const handler = gateway.require(price);
  await handler(
    shimReq as unknown as PaymentRequest,
    shimRes as unknown as PaymentResponse,
    () => {
      nextCalled = true;
    },
  );
  statusCode = shimRes.statusCode;
  if (nextCalled && shimReq.payment !== undefined) {
    const payment = shimReq.payment;
    if (payment.transaction === undefined || payment.transaction === "") {
      return {
        paid: false,
        status: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "settlement produced no transaction" }),
      };
    }
    return {
      paid: true,
      payer: payment.payer,
      amount: payment.amount,
      network: payment.network,
      transaction: payment.transaction,
    };
  }
  return { paid: false, status: statusCode, headers: outHeaders, body: outBody };
}

const gateways = new Map<string, GatewayMiddleware>();

function gatewayFor(seller: string): GatewayMiddleware {
  const cached = gateways.get(seller.toLowerCase());
  if (cached !== undefined) return cached;
  const created = createGatewayMiddleware({
    sellerAddress: seller,
    networks: [RESALE_NETWORK],
    facilitatorUrl: RESALE_FACILITATOR_URL,
    description: "Coalition resale quota leg",
  });
  gateways.set(seller.toLowerCase(), created);
  return created;
}

/**
 * POST /api/resale/quota {seller, mb, cu} — per-seller 402 route. Prices the
 * leg at cost basis from the live quote (mb*rateMB + floor(cu*rateCU),
 * atomic → USDC-decimal price string) and protects the request with
 * createGatewayMiddleware for that seller on eip155:5042002 / USDC. Unpaid
 * callers get the 402 + PAYMENT-REQUIRED header; paid callers get
 * {settlementId, amountAtomic, seller} for the /transfer-quota proof.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = (await request.json()) as unknown;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as { seller?: unknown }).seller !== "string" ||
    !ADDRESS_PATTERN.test((body as { seller: string }).seller)
  ) {
    return NextResponse.json(
      { ok: false, error: "body needs {seller: 0x…, mb: int, cu: number}" },
      { status: 400 },
    );
  }
  const { seller } = body as { seller: string };
  const mb = (body as { mb?: unknown }).mb;
  const cu = (body as { cu?: unknown }).cu;
  if (
    typeof mb !== "number" ||
    !Number.isInteger(mb) ||
    mb < 0 ||
    typeof cu !== "number" ||
    !Number.isFinite(cu) ||
    cu < 0 ||
    (mb === 0 && cu === 0)
  ) {
    return NextResponse.json(
      { ok: false, error: "mb/cu must be non-negative with at least one dimension wanted" },
      { status: 400 },
    );
  }

  let rateMB: bigint;
  let rateCU: bigint;
  try {
    const quote = await fetchQuote({ baseUrl: orchestratorBaseUrl(), seller });
    rateMB = quote.ratePerMBAtomic;
    rateCU = quote.ratePerCUAtomic;
  } catch (error) {
    log("warn", "resale.quota.no_quote", {
      route: "POST /api/resale/quota",
      seller,
      error: errorMessage(error),
    });
    return NextResponse.json(
      { ok: false, error: `no resale quote for seller: ${errorMessage(error)}` },
      { status: 409 },
    );
  }

  let cost: bigint;
  try {
    cost = BigInt(mb) * rateMB + cuLegCost(rateCU, cu);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: `cannot price leg: ${errorMessage(error)}` },
      { status: 400 },
    );
  }
  if (cost <= 0n) {
    return NextResponse.json(
      { ok: false, error: "leg prices at zero — nothing to charge" },
      { status: 400 },
    );
  }
  const price = atomicToUsdcPrice(cost);

  let gate: GateResult;
  try {
    gate = await runQuotaGate(gatewayFor(seller), request, price);
  } catch (error) {
    log("warn", "resale.quota.gate_error", {
      route: "POST /api/resale/quota",
      seller,
      error: errorMessage(error),
    });
    return NextResponse.json(
      { ok: false, error: `payment gate failed: ${errorMessage(error)}` },
      { status: 502 },
    );
  }
  if (!gate.paid) {
    const headers = new Headers({ "content-type": "application/json" });
    for (const [name, value] of Object.entries(gate.headers)) {
      try {
        headers.set(name, value);
      } catch {
        continue;
      }
    }
    return new Response(gate.body === "" ? "{}" : gate.body, {
      status: gate.status,
      headers,
    });
  }
  log("info", "resale.quota.paid", {
    route: "POST /api/resale/quota",
    seller,
    payer: gate.payer,
    amount: gate.amount,
    network: gate.network,
  });
  const headers = new Headers({ "content-type": "application/json" });
  return NextResponse.json({
    ok: true,
    seller,
    mb,
    cu,
    amountAtomic: cost.toString(),
    settlementId: gate.transaction,
    payer: gate.payer,
    network: gate.network,
  }, { headers });
}
