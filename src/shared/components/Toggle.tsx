interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Text to the right of the switch; omit for a bare control in a table. */
  label?: string;
  title?: string;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent) => void;
}

/**
 * A switch rather than a checkbox: these settings take effect immediately,
 * and a switch reads as on/off state where a checkbox reads as a pending
 * selection waiting on a Save button.
 */
export function Toggle({
  checked,
  onChange,
  label,
  title,
  disabled,
  onClick,
}: Props) {
  return (
    <label
      className={`flex items-center gap-2 text-xs ${
        disabled ? "cursor-default opacity-50" : "cursor-pointer"
      }`}
      title={title}
      onClick={onClick}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label ?? title}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative h-[18px] w-8 flex-none rounded-full border transition-colors ${
          checked
            ? "border-brand bg-brand"
            : "border-edge bg-elevated hover:border-muted"
        }`}
      >
        <span
          className={`absolute top-[2px] h-3 w-3 rounded-full bg-white transition-[left] duration-150 ${
            checked ? "left-[15px]" : "left-[2px]"
          }`}
        />
      </button>
      {label && <span className="text-ink">{label}</span>}
    </label>
  );
}
