// Small shared controls. Class names match style.css exactly — the stylesheet is
// unchanged from the pre-Preact UI.
import type { ComponentChildren } from "preact";

export function Field(
  { label, children, width }: {
    label: string;
    children: ComponentChildren;
    /** `grow` takes the leftover width of the rule; `narrow` fits a short number. */
    width?: "grow" | "narrow";
  },
) {
  return (
    <div class={width ? `field ${width}` : "field"}>
      <label>{label}</label>
      {children}
    </div>
  );
}

export function Check(
  { label, checked, onChange }: {
    label: string;
    checked: boolean;
    onChange: (v: boolean) => void;
  },
) {
  return (
    <label class="check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      {label}
    </label>
  );
}

/**
 * A hover/focus popover. `title` gives you the OS tooltip: unstyled, slow to
 * appear, one cramped column, and unreachable by keyboard — no good for a
 * pill whose whole job is to hold the detail.
 *
 * Kept to CSS `:hover` / `:focus-within` so there is no state to leak when the
 * pointer leaves, and `tabindex` so it opens from the keyboard too.
 */
export function Tooltip(
  { rows, children }: {
    /** `[label, value]` pairs; a null value drops the row. */
    rows: [string, string | null][];
    children: ComponentChildren;
  },
) {
  const visible = rows.filter((r): r is [string, string] => r[1] !== null);
  if (!visible.length) return <>{children}</>;

  return (
    <span class="tip-host" tabIndex={0}>
      {children}
      <span class="tip" role="tooltip">
        {visible.map(([label, value]) => (
          <span class="tip-row" key={label}>
            <span class="tip-key">{label}</span>
            <span class="tip-val">{value}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * A centred dialog over a scrim. Deliberately not <dialog>: WebKit in the
 * desktop shell is the target (§16), and this needs no polyfilling.
 */
export function Modal(
  { title, onClose, children }: {
    title: string;
    onClose: () => void;
    children: ComponentChildren;
  },
) {
  return (
    // Clicking the backdrop closes; clicks inside must not bubble up to it.
    <div class="scrim" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <span class="spacer" />
          <button type="button" title="Close" onClick={onClose}>✕</button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function Select(
  { value, options, onChange }: {
    value: string;
    /** `[value, label]` pairs. */
    options: [string, string][];
    onChange: (v: string) => void;
  },
) {
  return (
    <select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
      {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  );
}
