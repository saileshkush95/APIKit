// Discussion threads attached to saved requests.
//
// Comments are written one at a time rather than as a whole-array save, so two
// people commenting at the same moment cannot overwrite each other — each row
// syncs independently.

import { useCallback } from "react";
import { create } from "zustand";
import { deleteComment, saveComment } from "../lib/api";
import { notifyError } from "../lib/notify";
import { newId, workspaceDataOnce } from "../lib/storage";
import { useSettings } from "./settings";
import type { Comment } from "../types";

interface CommentsStore {
  workspaceId: string;
  comments: Comment[];
  load: (workspaceId: string) => Promise<void>;
  add: (requestId: string, body: string, parentId?: string | null) => void;
  edit: (id: string, body: string) => void;
  remove: (id: string) => void;
}

export const useCommentsStore = create<CommentsStore>()((set, get) => ({
  workspaceId: "",
  comments: [],

  load: async (workspaceId) => {
    set({ workspaceId });
    try {
      const workspace = await workspaceDataOnce(workspaceId);
      set({ comments: workspace.comments ?? [] });
    } catch (e) {
      notifyError("Could not load comments", e);
    }
  },

  add: (requestId, body, parentId = null) => {
    const trimmed = body.trim();
    if (trimmed === "") return;
    const comment: Comment = {
      id: newId(),
      requestId,
      parentId,
      author: useSettings.getState().settings.userName.trim() || "Anonymous",
      body: trimmed,
      createdAt: Date.now(),
    };
    set({ comments: [...get().comments, comment] });
    saveComment(get().workspaceId, comment).catch((e) =>
      notifyError("Could not save the comment", e),
    );
  },

  edit: (id, body) => {
    const trimmed = body.trim();
    if (trimmed === "") return;
    const comments = get().comments.map((comment) =>
      comment.id === id ? { ...comment, body: trimmed } : comment,
    );
    set({ comments });
    const changed = comments.find((comment) => comment.id === id);
    if (changed) {
      saveComment(get().workspaceId, changed).catch((e) =>
        notifyError("Could not save the comment", e),
      );
    }
  },

  remove: (id) => {
    // Replies go with their parent, matching what the thread shows.
    set({
      comments: get().comments.filter(
        (comment) => comment.id !== id && comment.parentId !== id,
      ),
    });
    deleteComment(id).catch((e) =>
      notifyError("Could not delete the comment", e),
    );
  },
}));

/** Same shape the provider exposed, so consumers are unchanged. */
export function useComments() {
  // `forRequest` is built here rather than inside a selector: a new closure
  // per comparison would never settle, and React would give up with
  // "Maximum update depth exceeded".
  const comments = useCommentsStore((s) => s.comments);
  const add = useCommentsStore((s) => s.add);
  const edit = useCommentsStore((s) => s.edit);
  const remove = useCommentsStore((s) => s.remove);

  const forRequest = useCallback(
    (requestId: string) =>
      comments.filter((comment) => comment.requestId === requestId),
    [comments],
  );

  return { comments, forRequest, add, edit, remove };
}
