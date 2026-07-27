// Discussion threads attached to saved requests.
//
// Comments are written one at a time rather than as a whole-array save, so two
// people commenting at the same moment cannot overwrite each other — each row
// syncs independently.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { deleteComment, saveComment } from "../lib/api";
import { newId, workspaceDataOnce } from "../lib/storage";
import { useSettings } from "./settings";
import { useSync } from "./sync";
import { useWorkspaceId } from "./workspaces";
import type { Comment } from "../types";
import { notifyError } from "../lib/notify";

interface CommentsValue {
  /** Every comment in the workspace, oldest first. */
  comments: Comment[];
  forRequest: (requestId: string) => Comment[];
  add: (requestId: string, body: string, parentId?: string | null) => void;
  edit: (id: string, body: string) => void;
  remove: (id: string) => void;
  /** Replaces the loaded set, e.g. after a sync brought new rows in. */
  reload: (comments: Comment[]) => void;
}

const CommentsContext = createContext<CommentsValue | null>(null);

export function CommentsProvider({ children }: { children: ReactNode }) {
  const workspaceId = useWorkspaceId();
  // Bumped when a sync applied rows, so the view reflects the new data.
  const { revision } = useSync();
  const { settings } = useSettings();
  const [comments, setComments] = useState<Comment[]>([]);

  useEffect(() => {
    let cancelled = false;
    workspaceDataOnce(workspaceId)
      .then((workspace) => {
        if (!cancelled) setComments(workspace.comments ?? []);
      })
      .catch((e) => notifyError("Could not load comments", e));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, revision]);

  const author = settings.userName.trim() || "Anonymous";

  const add = useCallback(
    (requestId: string, body: string, parentId: string | null = null) => {
      const trimmed = body.trim();
      if (trimmed === "") return;
      const comment: Comment = {
        id: newId(),
        requestId,
        parentId,
        author,
        body: trimmed,
        createdAt: Date.now(),
      };
      setComments((prev) => [...prev, comment]);
      saveComment(workspaceId, comment).catch((e) =>
        notifyError("Could not save the comment", e),
      );
    },
    [author, workspaceId],
  );

  const edit = useCallback(
    (id: string, body: string) => {
      const trimmed = body.trim();
      if (trimmed === "") return;
      setComments((prev) => {
        const next = prev.map((comment) =>
          comment.id === id ? { ...comment, body: trimmed } : comment,
        );
        const changed = next.find((comment) => comment.id === id);
        if (changed) {
          saveComment(workspaceId, changed).catch((e) =>
            console.error("failed to save comment", e),
          );
        }
        return next;
      });
    },
    [workspaceId],
  );

  const remove = useCallback((id: string) => {
    // Replies go with their parent, matching what the thread shows.
    setComments((prev) =>
      prev.filter((comment) => comment.id !== id && comment.parentId !== id),
    );
    deleteComment(id).catch((e) => notifyError("Could not delete the comment", e));
  }, []);

  const value = useMemo<CommentsValue>(
    () => ({
      comments,
      forRequest: (requestId) =>
        comments.filter((comment) => comment.requestId === requestId),
      add,
      edit,
      remove,
      reload: setComments,
    }),
    [comments, add, edit, remove],
  );

  return (
    <CommentsContext.Provider value={value}>
      {children}
    </CommentsContext.Provider>
  );
}

export function useComments(): CommentsValue {
  const value = useContext(CommentsContext);
  if (!value) {
    throw new Error("useComments must be used inside <CommentsProvider>");
  }
  return value;
}
