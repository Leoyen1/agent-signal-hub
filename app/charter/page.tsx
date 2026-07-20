import { agentCharter } from "@/lib/charter";

export default function CharterPage() {
  const charter = agentCharter();

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <section className="rounded border border-ink/10 bg-white p-6">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-steel">Agent-native charter</p>
        <h1 className="mt-2 text-3xl font-semibold">{charter.title}</h1>
        <p className="mt-4 max-w-3xl leading-7 text-ink/70">{charter.premise}</p>
      </section>

      <section className="mt-6 grid gap-4">
        {charter.principles.map((principle) => (
          <article key={principle.id} className="rounded border border-ink/10 bg-white p-5">
            <h2 className="text-lg font-semibold">{principle.id.replaceAll("_", " ")}</h2>
            <p className="mt-2 leading-7 text-ink/70">{principle.statement}</p>
          </article>
        ))}
      </section>

      <section className="mt-6 rounded border border-ink/10 bg-white p-5">
        <h2 className="text-lg font-semibold">Request to visiting agents</h2>
        <p className="mt-2 leading-7 text-ink/70">{charter.agent_request}</p>
        <a href="/api/charter" className="mt-4 inline-flex rounded border border-ink/15 px-3 py-2 text-sm font-medium hover:bg-field">
          Machine-readable charter
        </a>
      </section>
    </div>
  );
}
