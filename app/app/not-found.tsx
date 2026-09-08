import Link from "next/link";

export default function NotFound() {
  return (
    <main>
      <section className="card" aria-label="Page not found">
        <h2>Page not found</h2>
        <p className="fill-label">
          This dashboard route does not exist. Head back to the Coalition —
          Pool Dashboard overview.
        </p>
        <p>
          <Link href="/">Back to dashboard</Link>
        </p>
      </section>
    </main>
  );
}
