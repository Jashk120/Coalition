import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the actual route with isolated Circle/RPC dependencies: no test
// credentials or on-chain transactions are needed.
const source = readFileSync(new URL("../app/api/agents/rotate/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture({ source = "chain", expired = true, settled = false, roundId = "7", failFinalize = false } = {}) {
  const calls = [];
  const exports = {};
  let reads = 0;
  const dependencies = {
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    "@/lib/constants": { POOL_ADDRESS: "pool" },
    "@/lib/logger": { log() {} },
    "@/lib/circle-fund": {
      readCircleEnv: () => ({ ok: true, apiKey: "test", entitySecret: "test", walletIds: ["agent"] }),
      createCircleClient: () => ({}),
      executeContractAndWait: async (_, args) => {
        calls.push(args.abiFunctionSignature);
        if (failFinalize && args.abiFunctionSignature.startsWith("finalize")) return { ok: false, error: "RPC failed" };
        return { ok: true, txHash: "0xreceipt" };
      },
    },
    "@/lib/pool-state": {
      orchestratorBaseUrl: () => "http://orchestrator",
      readCurrentRound: async () => ({ source, view: {
        roundId: reads++ === 0 ? roundId : "8", expired, settled, deadline: "1900000000",
      } }),
    },
  };
  runInNewContext(compiled, {
    exports, require: (id) => dependencies[id] ?? createRequire(import.meta.url)(id),
    process: { env: { CIRCLE_PROVIDER_WALLET_ID: "provider" } },
    fetch: async () => ({ ok: true }), AbortSignal,
  });
  return { calls, post: (body = { expectedRoundId: "7", expiredOnly: true }) => exports.POST({ json: async () => body }) };
}

test("expired round is finalized before the next round starts", async () => {
  const f = fixture();
  const response = await f.post();
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls, ["finalizeExpired(uint256)", "startRound(uint256,uint64,uint256)"]);
  assert.equal(response.body.result.newRoundId, "8");
});

for (const [name, state, status] of [
  ["open round", { expired: false }, 409],
  ["settled round", { settled: true }, 409],
  ["stale round", { roundId: "8" }, 409],
  ["unverified round", { source: "fallback" }, 503],
]) {
  test(`automatic rotation does not submit transactions for a ${name}`, async () => {
    const f = fixture(state);
    assert.equal((await f.post()).status, status);
    assert.deepEqual(f.calls, []);
  });
}

test("finalization failure prevents startRound", async () => {
  const f = fixture({ failFinalize: true });
  assert.equal((await f.post()).status, 500);
  assert.deepEqual(f.calls, ["finalizeExpired(uint256)"]);
});

test("overlapping rotations are rejected before submitting a second transaction", async () => {
  const f = fixture();
  const first = f.post();
  assert.equal((await f.post()).status, 409);
  assert.equal((await first).status, 200);
  assert.equal(f.calls.length, 2);
});

test("manual rotation of a settled round still skips finalization", async () => {
  const f = fixture({ settled: true, expired: false });
  assert.equal((await f.post({})).status, 200);
  assert.deepEqual(f.calls, ["startRound(uint256,uint64,uint256)"]);
});
