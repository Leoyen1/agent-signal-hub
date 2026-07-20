export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded border border-ink/10 bg-ink p-4 text-sm leading-6 text-field">
      <code>{children}</code>
    </pre>
  );
}
