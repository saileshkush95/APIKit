// The Settings page's visual language — titled sections of labeled rows —
// shared so feature pages (e.g. monitor email setup) can match it.

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-edge py-5 last:border-0">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {description && (
        <p className="mt-0.5 text-xs text-muted">{description}</p>
      )}
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4">
      <div className="w-56 flex-none">
        <div className="text-xs text-ink">{label}</div>
        {hint && <div className="text-[11px] text-muted">{hint}</div>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
