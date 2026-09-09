import type {
  Account,
  Address,
  Hash,
  PublicClient,
  WalletClient,
} from "viem";

import {
  registerSubname,
  resolveArcWallet,
  resolveEnsResolver,
} from "./client.js";
import { EnsError } from "./types.js";

export type RegisterAndVerifySubnameParams = {
  /** Sepolia signer for the `register` write (ENSv2 beta). */
  readonly walletClient: WalletClient;
  readonly account: Account;
  /** Sepolia read client — receipt wait + Universal Resolver wildcard reads. */
  readonly sepoliaClient: PublicClient;
  /** Parent registrar — always explicit (one parent, one deployment). */
  readonly registrar: Address;
  readonly label: string;
  readonly parentName?: string;
  readonly owner: Address;
  readonly registry: Address;
  readonly resolver: Address;
  /** EAC role bitmap (e.g. SET_SUBREGISTRY|SET_RESOLVER|CAN_TRANSFER_ADMIN). */
  readonly roleBitmap: bigint;
  readonly expiry: bigint;
  readonly coinType?: number;
  readonly universalResolver?: Address;
};

export type RegisterAndVerifySubnameResult = {
  /** Fully-qualified name that was registered (`label.parentName`). */
  readonly name: string;
  readonly registerTx: Hash;
  /** Arc wallet from the wildcard-resolved multicoin record — never null. */
  readonly arcWallet: Address;
  /** Live resolver observed at verify time (looked up fresh, never cached). */
  readonly resolver: Address;
};

/**
 * Strict register-then-verify: registers `label.parentName` via the existing
 * `registerSubname`, waits for inclusion, then wildcard-resolves it via the
 * Universal Resolver (`resolveArcWallet`).
 *
 * There is deliberately NO fallback wallet on this path — a missing Arc
 * record after registration is an `EnsError`, so a successful return proves
 * ENS is loadbearing (not a hardcoded value).
 */
export async function registerAndVerifySubname(
  params: RegisterAndVerifySubnameParams,
): Promise<RegisterAndVerifySubnameResult> {
  const { hash, name } = await registerSubname({
    walletClient: params.walletClient,
    account: params.account,
    registrar: params.registrar,
    label: params.label,
    ...(params.parentName === undefined ? {} : { parentName: params.parentName }),
    owner: params.owner,
    registry: params.registry,
    resolver: params.resolver,
    roleBitmap: params.roleBitmap,
    expiry: params.expiry,
  });

  await params.sepoliaClient.waitForTransactionReceipt({ hash });

  const resolver = await resolveEnsResolver({
    publicClient: params.sepoliaClient,
    name,
    ...(params.universalResolver === undefined
      ? {}
      : { universalResolver: params.universalResolver }),
  });

  const arcWallet = await resolveArcWallet({
    publicClient: params.sepoliaClient,
    name,
    ...(params.coinType === undefined ? {} : { coinType: params.coinType }),
    ...(params.universalResolver === undefined
      ? {}
      : { universalResolver: params.universalResolver }),
  });
  if (arcWallet === null) {
    throw new EnsError(
      `no Arc record for "${name}" after registration ${hash}`,
    );
  }

  return { name, registerTx: hash, arcWallet, resolver };
}
