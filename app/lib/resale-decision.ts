/**
 * Pure resale-buy decision for the autonomous agent-5 path.
 *
 * I/O-free and deterministic: given the requested mint dimensions, the
 * orchestrator capacity headroom (or null when /capacity is unavailable),
 * and the subgraph pool-health counts (or null when the subgraph read
 * failed), decide whether the agent should buy. A null health always
 * fails closed to skip — The Graph is load-bearing for this decision.
 */

/** Requested mint dimensions: MB plus micro-CU (cu * 1e6, rounded). */
export type ResaleBuyWant = {
  readonly mem: number;
  readonly cuMicro: number;
};

/** Pool-global unreserved spare from orchestrator GET /capacity. */
export type ResaleCapacityHeadroom = {
  readonly headroomMB: number;
  readonly headroomCUMicro: number;
};

/** Subgraph pool-health counts, kept JSON-safe for the trace. */
export type ResaleHealthCounts = {
  readonly settled: boolean;
  readonly participantCount: number;
  readonly forfeitedTotalAtomic: string;
  readonly dropoutCount: number;
};

export type ResaleDecisionInput = {
  readonly want: ResaleBuyWant;
  /** Null when the orchestrator has no /capacity yet — subgraph health decides alone. */
  readonly capacity: ResaleCapacityHeadroom | null;
  /** Null when the subgraph read failed — the decision fails closed to skip. */
  readonly health: ResaleHealthCounts | null;
  /** Subgraph failure detail; set exactly when health is null. */
  readonly subgraphError: string | null;
};

export type ResaleDecision = {
  readonly action: "buy" | "skip";
  readonly reason: string;
  readonly trace: {
    readonly want: ResaleBuyWant;
    readonly headroom: ResaleCapacityHeadroom | null;
    readonly health: ResaleHealthCounts | null;
    readonly subgraphError: string | null;
    readonly reasons: readonly string[];
  };
};

/**
 * Decide buy vs skip over capacity headroom + subgraph pool health.
 * Rule order is the reason order in the trace: the first failing rule
 * is the reason, every rule considered is listed.
 */
export function decideResaleBuy(input: ResaleDecisionInput): ResaleDecision {
  const reasons: string[] = [];
  const trace = {
    want: input.want,
    headroom: input.capacity,
    health: input.health,
    subgraphError: input.subgraphError,
    reasons,
  };

  if (input.health === null) {
    const detail =
      input.subgraphError !== null && input.subgraphError !== ""
        ? input.subgraphError
        : "subgraph health unavailable";
    reasons.push("subgraph health unavailable (fail-closed)");
    return { action: "skip", reason: `skip: ${detail}`, trace };
  }
  const health = input.health;

  reasons.push(
    health.settled ? "pool settled" : "pool not settled",
  );
  if (health.settled) {
    return { action: "skip", reason: "skip: pool is settled", trace };
  }

  const unreliable = health.dropoutCount * 2 > health.participantCount;
  reasons.push(
    unreliable
      ? `pool unreliable: ${String(health.dropoutCount)} dropouts over ${String(health.participantCount)} participants`
      : `pool reliable: ${String(health.dropoutCount)} dropouts over ${String(health.participantCount)} participants`,
  );
  if (unreliable) {
    return {
      action: "skip",
      reason: `skip: pool unreliable (${String(health.dropoutCount)} dropouts over ${String(health.participantCount)} participants)`,
      trace,
    };
  }

  if (input.capacity !== null) {
    const overMem = input.want.mem > input.capacity.headroomMB;
    reasons.push(
      overMem
        ? `want ${String(input.want.mem)}MB exceeds headroom ${String(input.capacity.headroomMB)}MB`
        : `want ${String(input.want.mem)}MB fits headroom ${String(input.capacity.headroomMB)}MB`,
    );
    if (overMem) {
      return {
        action: "skip",
        reason: `skip: want ${String(input.want.mem)}MB exceeds headroom ${String(input.capacity.headroomMB)}MB`,
        trace,
      };
    }
    const overCu = input.want.cuMicro > input.capacity.headroomCUMicro;
    reasons.push(
      overCu
        ? `want ${String(input.want.cuMicro)}cuMicro exceeds headroom ${String(input.capacity.headroomCUMicro)}cuMicro`
        : `want ${String(input.want.cuMicro)}cuMicro fits headroom ${String(input.capacity.headroomCUMicro)}cuMicro`,
    );
    if (overCu) {
      return {
        action: "skip",
        reason: `skip: want ${String(input.want.cuMicro)}cuMicro exceeds headroom ${String(input.capacity.headroomCUMicro)}cuMicro`,
        trace,
      };
    }
  } else {
    reasons.push("no capacity snapshot; subgraph health decides alone");
  }

  reasons.push("buy: pool open, reliable, and want fits headroom");
  return { action: "buy", reason: "buy: pool open and want fits", trace };
}
