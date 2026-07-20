import { clsx } from "clsx";

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "warn" | "bad" }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded border px-2 py-1 text-xs font-medium",
        tone === "neutral" && "border-ink/10 bg-field text-ink/70",
        tone === "good" && "border-moss/20 bg-moss/10 text-moss",
        tone === "warn" && "border-amber/25 bg-amber/10 text-amber",
        tone === "bad" && "border-signal/25 bg-signal/10 text-signal",
      )}
    >
      {children}
    </span>
  );
}
