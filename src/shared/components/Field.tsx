// Form primitives.
//
// Every text field, dropdown and textarea in the app renders through these, so
// a select sits at exactly the same height as the input beside it. The styling
// itself lives in `.wrk-field` in App.css — a native <select> sizes itself from
// its own font metrics and draws its own arrow, so the appearance is reset
// there and the chevron drawn as a background image.

import type {
  InputHTMLAttributes,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from "react";

/** `compact` for dense rows and toolbars, `lg` for the URL bar. */
export type FieldSize = "compact" | "default" | "lg";

function classes(
  size: FieldSize | undefined,
  mono: boolean | undefined,
  extra: string | undefined,
): string {
  return [
    "wrk-field",
    size && size !== "default" ? size : "",
    mono ? "mono" : "",
    extra ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

interface Common {
  size?: FieldSize;
  /** Monospace, for URLs, headers, tokens and anything code-like. */
  mono?: boolean;
}

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> &
  Common & { ref?: Ref<HTMLInputElement> };

export function Input({ size, mono, className, ...rest }: InputProps) {
  return <input {...rest} className={classes(size, mono, className)} />;
}

// The dropdown draws its own list rather than using the native popup, which
// the OS styles and can render over the field itself.
export { Select } from "./Select";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> &
  Common;

export function Textarea({ size, mono, className, ...rest }: TextareaProps) {
  return <textarea {...rest} className={classes(size, mono, className)} />;
}

interface LabelledProps {
  label: string;
  /** Sits under the label, for the detail a label cannot carry. */
  hint?: string;
  children: ReactNode;
  className?: string;
}

/** Label to the left, control to the right — the settings-row layout. */
export function Labelled({ label, hint, children, className }: LabelledProps) {
  return (
    <div className={`flex items-center gap-4 ${className ?? ""}`}>
      <div className="w-56 flex-none">
        <div className="text-xs text-ink">{label}</div>
        {hint && <div className="text-[11px] text-muted">{hint}</div>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Label beside its control, for toolbars where space is tight. */
export function InlineField({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex items-center gap-1.5 text-xs text-muted ${className ?? ""}`}>
      {label}
      {children}
    </label>
  );
}
