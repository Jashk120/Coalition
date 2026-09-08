"use client";

export default function Error({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  return (
    <main>
      <section className="card" aria-label="Dashboard error">
        <h2>Something went wrong</h2>
        <p className="fill-label">
          The pool dashboard hit an unexpected error. Reads and dry-run
          decisions only — nothing was written on-chain.
        </p>
        <div className="state state-error" role="alert">
          {error.message}
          {error.digest !== undefined ? ` (digest: ${error.digest})` : null}
        </div>
        <p>
          <button className="trigger" type="button" onClick={() => reset()}>
            Try again
          </button>
        </p>
      </section>
    </main>
  );
}
