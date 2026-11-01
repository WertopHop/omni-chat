/**
 * Shared dialog shell: backdrop, card, Escape and a click outside to close.
 *
 * A dialog with `onSubmit` renders a form, so Enter in an input submits it.
 */
import { useEffect, type FormEvent, type ReactNode } from "react";

type Props = {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  onSubmit?: (event: FormEvent) => void;
  /** Blocks closing while a request is in flight. */
  busy?: boolean;
};

export function Modal({ title, children, footer, onClose, onSubmit, busy }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const content = (
    <>
      <h3>{title}</h3>
      {children}
      <div className="modal-actions">{footer}</div>
    </>
  );

  const dismiss = () => {
    if (!busy) onClose();
  };

  return (
    <div className="modal-backdrop" onClick={dismiss}>
      {onSubmit ? (
        <form
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onClick={(event) => event.stopPropagation()}
          onSubmit={onSubmit}
        >
          {content}
        </form>
      ) : (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onClick={(event) => event.stopPropagation()}
        >
          {content}
        </div>
      )}
    </div>
  );
}
