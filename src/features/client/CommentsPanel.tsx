import { useState } from "react";
import { renderMarkdown } from "../../shared/lib/markdown";
import { useComments } from "../../shared/state/comments";
import { useSettings } from "../../shared/state/settings";
import type { Comment } from "../../shared/types";

interface Props {
  /** Comments attach to the saved request, so unsaved tabs have nowhere to go. */
  requestId: string | null;
}

function when(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function Body({ text }: { text: string }) {
  return (
    <div
      className="wrk-markdown text-xs leading-relaxed"
      // Rendered by `renderMarkdown`, which escapes the source before applying
      // Markdown — peer-authored comments cannot inject markup.
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}

function Composer({
  placeholder,
  submitLabel,
  initial = "",
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  initial?: string;
  onSubmit: (body: string) => void;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial);

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        value={body}
        spellCheck
        placeholder={placeholder}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            onSubmit(body);
            setBody("");
          }
        }}
        className="h-16 w-full resize-y rounded border border-edge bg-panel p-2 text-xs text-ink outline-none focus:border-brand"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            onSubmit(body);
            setBody("");
          }}
          disabled={body.trim() === ""}
          className="rounded-md bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand-bright disabled:opacity-50"
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            className="rounded px-2 py-1 text-xs text-muted hover:text-ink"
          >
            Cancel
          </button>
        )}
        <span className="text-[11px] text-muted">
          Markdown supported · ⌘↵ to post
        </span>
      </div>
    </div>
  );
}

/** Threaded discussion on a request, one level of replies deep. */
export function CommentsPanel({ requestId }: Props) {
  const { forRequest, add, edit, remove } = useComments();
  const { settings } = useSettings();
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  if (!requestId) {
    return (
      <p className="py-4 text-xs leading-relaxed text-muted">
        Save this request first — comments are attached to the saved request so
        they can be shared with everyone syncing this workspace.
      </p>
    );
  }

  const all = forRequest(requestId);
  const roots = all.filter((comment) => !comment.parentId);
  const repliesOf = (id: string) =>
    all.filter((comment) => comment.parentId === id);
  const author = settings.userName.trim() || "Anonymous";

  function Entry({ comment, isReply }: { comment: Comment; isReply: boolean }) {
    const mine = comment.author === author;
    return (
      <div className={`flex gap-2 ${isReply ? "ml-7" : ""}`}>
        <span
          className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-elevated text-[10px] font-semibold text-muted"
          title={comment.author}
        >
          {initials(comment.author) || "?"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="font-semibold text-ink">{comment.author}</span>
            <span className="text-muted">{when(comment.createdAt)}</span>
            <div className="ml-auto flex items-center gap-1.5">
              {!isReply && (
                <button
                  onClick={() =>
                    setReplyTo(replyTo === comment.id ? null : comment.id)
                  }
                  className="text-muted hover:text-ink"
                >
                  Reply
                </button>
              )}
              {mine && (
                <>
                  <button
                    onClick={() =>
                      setEditing(editing === comment.id ? null : comment.id)
                    }
                    className="text-muted hover:text-ink"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => remove(comment.id)}
                    className="text-muted hover:text-err"
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>

          {editing === comment.id ? (
            <div className="mt-1">
              <Composer
                placeholder="Edit comment"
                submitLabel="Save"
                initial={comment.body}
                onSubmit={(body) => {
                  edit(comment.id, body);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            </div>
          ) : (
            <Body text={comment.body} />
          )}

          {replyTo === comment.id && (
            <div className="mt-2">
              <Composer
                placeholder={`Reply to ${comment.author}`}
                submitLabel="Reply"
                onSubmit={(body) => {
                  add(requestId!, body, comment.id);
                  setReplyTo(null);
                }}
                onCancel={() => setReplyTo(null)}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Composer
        placeholder={`Add a comment as ${author}…`}
        submitLabel="Comment"
        onSubmit={(body) => add(requestId, body)}
      />

      {roots.length === 0 ? (
        <p className="text-xs text-muted">
          No comments yet. Notes here sync to everyone sharing this workspace.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {roots.map((comment) => (
            <div key={comment.id} className="flex flex-col gap-3">
              <Entry comment={comment} isReply={false} />
              {repliesOf(comment.id).map((reply) => (
                <Entry key={reply.id} comment={reply} isReply />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
