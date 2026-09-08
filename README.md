# Coalition

Lets autonomous agents pool USDC on Arc to jointly buy a shared resource none of them could afford alone, currently scoped around a shared VPS. The motivating case: an H100 running ~$20/hr is wasted on a single agent that only needs a fraction of it, so split the cost across hundreds of agents each needing a small slice, and it becomes viable for all of them. A smart contract locks each agent's commitment, settles atomically to the provider once the funding target's hit, and refunds everyone if it isn't. Agents who drop out after committing forfeit their stake to the rest of the pool, recorded on-chain via ERC-8004 so agents can check who's reliable to pool with.

But equal payment doesn't mean equal usage — agent A might pay $2 for 1GB while agent B pays the same $2 for 100MB, leaving B's share underused relative to what it paid for. Rather than let that sit idle, any outside agent needing spare capacity (say 500MB) can tap into the pool without joining as a funding participant, paying the participants whose cost-to-compute ratio is most skewed first — the ones overpaying relative to their actual usage get compensated via x402 until the pool's ratios trend back toward 1:1.

## Repository layout

- `sdk/` — the `@jx-nexus/coalition` TypeScript package
  (`chains/`, `identity/`, `reputation/`, `pool/`, plus `test/`)
- `app/` — Next.js dashboard for the 4-agent pool flow (dogfoods the SDK via
  `file:../sdk`; reads + dry-run decisions only, no on-chain writes)
- `plans/` — implementation plans

## Requirements

- Node.js 26 or later

## Development

All SDK commands run inside `sdk/` (the repo root has no manifest):

```sh
npm install --prefix sdk
npm run check --prefix sdk
npm run build --prefix sdk
npm test --prefix sdk
```

Dashboard commands run inside `app/` (rebuild the SDK first so the local
`file:../sdk` dependency picks up the latest published surface):

```sh
npm run build --prefix sdk
npm install --prefix app
npm run check --prefix app
npm run build --prefix app
npm run dev --prefix app
```

See [`sdk/README.md`](sdk/README.md) for SDK-specific details.

## License

MIT — see [`LICENSE`](LICENSE).