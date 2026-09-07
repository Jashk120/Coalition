/** Aggregated reputation: how many feedbacks and their fixed-point value. */
export type ReputationSummary = {
  readonly count: bigint;
  readonly value: bigint;
  readonly decimals: number;
};

/** One stored feedback entry with its revocation state. */
export type FeedbackEntry = {
  readonly value: bigint;
  readonly decimals: number;
  readonly tag1: string;
  readonly tag2: string;
  readonly revoked: boolean;
};

/** Thrown when a reputation read is invalid before any network call. */
export class ReputationRegistryError extends Error {
  readonly name = "ReputationRegistryError";
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
  }
}
