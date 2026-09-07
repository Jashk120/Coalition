# Coalition

A TypeScript SDK for Coalition.

## Repository layout

- `sdk/` — the `@jx-nexus/coalition` TypeScript package
  (`chains/`, `identity/`, `reputation/`, `pool/`, plus `test/`)
- `plans/` — implementation plans

## Requirements

- Node.js 26 or later

## Development

All commands run inside `sdk/` (the repo root has no manifest):

```sh
npm install --prefix sdk
npm run check --prefix sdk
npm run build --prefix sdk
npm test --prefix sdk
```

See [`sdk/README.md`](sdk/README.md) for SDK-specific details.

## License

MIT — see [`LICENSE`](LICENSE).