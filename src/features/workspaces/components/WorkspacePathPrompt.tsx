import { useEffect, useRef } from "react";

type WorkspacePathPromptProps = {
  path: string;
  error?: string | null;
  isBusy?: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function WorkspacePathPrompt({
  path,
  error = null,
  isBusy = false,
  onChange,
  onCancel,
  onConfirm,
}: WorkspacePathPromptProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="worktree-modal" role="dialog" aria-modal="true">
      <div
        className="worktree-modal-backdrop"
        onClick={() => {
          if (!isBusy) {
            onCancel();
          }
        }}
      />
      <div className="worktree-modal-card">
        <div className="worktree-modal-title">Add workspace</div>
        <div className="worktree-modal-subtitle">
          Enter the local project path to connect.
        </div>
        <label className="worktree-modal-label" htmlFor="workspace-path-input">
          Workspace path
        </label>
        <input
          id="workspace-path-input"
          ref={inputRef}
          className="worktree-modal-input"
          value={path}
          placeholder="/Users/you/projects/my-repo"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              if (!isBusy) {
                onCancel();
              }
            }
            if (event.key === "Enter" && !isBusy) {
              event.preventDefault();
              onConfirm();
            }
          }}
        />
        {error ? <div className="worktree-modal-error">{error}</div> : null}
        <div className="worktree-modal-actions">
          <button
            className="ghost worktree-modal-button"
            onClick={onCancel}
            type="button"
            disabled={isBusy}
          >
            Cancel
          </button>
          <button
            className="primary worktree-modal-button"
            onClick={onConfirm}
            type="button"
            disabled={isBusy || path.trim().length === 0}
          >
            {isBusy ? "Adding…" : "Add workspace"}
          </button>
        </div>
      </div>
    </div>
  );
}
