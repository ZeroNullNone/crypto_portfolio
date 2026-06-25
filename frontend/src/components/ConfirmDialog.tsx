import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  danger = false,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  // Close on Escape when open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open || typeof document === "undefined") return null;

  const dialog = (
    <div
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="modal-overlay strong"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-card strong"
        style={{
          maxWidth: 420,
          border: "2.5px solid var(--line)",
          borderRadius: 6,
          padding: 16,
          fontFamily: "var(--head)",
          color: "var(--ink)",
          position: "relative",
          zIndex: 1,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 12,
          }}
        >
          <span
            id="confirm-dialog-title"
            style={{
              fontFamily: "var(--head)",
              fontWeight: 500,
              fontSize: 18,
              letterSpacing: "-0.015em",
            }}
          >
            {title}
          </span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="icon-close"
          >
            ✕
          </button>
        </div>
        <div
          style={{
            marginBottom: 16,
            fontFamily: "var(--head)",
            fontSize: 14,
            lineHeight: 1.55,
            letterSpacing: "-0.005em",
            color: "var(--ink-2)",
          }}
        >
          {message}
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            justifyContent: "flex-end",
          }}
        >
          <button type="button" className="wbtn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={"wbtn " + (danger ? "accent" : "primary")}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
