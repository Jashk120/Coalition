/**
 * No default pool address is exported on purpose.
 *
 * Scope is one pool on one VPS; the address comes from the deploy output
 * and is always passed explicitly as `pool`. A checked-in default would
 * silently point at a stale or wrong pool after every redeploy.
 */
export {};
