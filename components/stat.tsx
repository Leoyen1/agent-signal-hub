import type { LucideIcon } from "lucide-react";

export function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded border border-ink/10 bg-white p-5 shadow-line">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink/60">{label}</p>
        <Icon size={18} className="text-signal" />
      </div>
      <p className="mt-4 text-3xl font-semibold">{value}</p>
    </div>
  );
}
