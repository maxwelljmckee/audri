// Reactive RxDB query hooks for the todos sidecar (v0.2.1).
//
//   useTodos()                   — all the user's todos. The Todos plugin
//                                   groups them client-side by parent_page_id
//                                   into vertical swimlane sections.
//   useTodoForPage(pageId)       — single sidecar row by wiki page id (1:1).
//                                   Used to display status on a wiki page
//                                   detail view (when surfaced).
//
// Mutations:
//   updateTodoStatus(id, status) — check-off / archive flow.
//   updateTodoParent(id, parent) — re-associate a todo across swimlanes.
//   Both bump updated_at so push replication picks the change up.

import { useEffect, useState } from 'react';
import { getDatabase } from './database';
import type { TodoDoc } from './schemas';

export function useTodos(): TodoDoc[] {
  const [docs, setDocs] = useState<TodoDoc[]>([]);

  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined;
    let cancelled = false;

    void getDatabase().then((db) => {
      if (cancelled) return;
      sub = db.collections.todos
        .find({ sort: [{ updated_at: 'desc' }] })
        // biome-ignore lint/suspicious/noExplicitAny: RxDocument shape is narrow
        .$.subscribe((rows: any[]) => {
          setDocs(rows.map((d) => d.toJSON() as TodoDoc));
        });
    });

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, []);

  return docs;
}

export function useTodoForPage(pageId: string | null): TodoDoc | null {
  const [doc, setDoc] = useState<TodoDoc | null>(null);

  useEffect(() => {
    if (!pageId) {
      setDoc(null);
      return;
    }
    let sub: { unsubscribe: () => void } | undefined;
    let cancelled = false;

    void getDatabase().then((db) => {
      if (cancelled) return;
      sub = db.collections.todos
        .findOne({ selector: { page_id: pageId } })
        // biome-ignore lint/suspicious/noExplicitAny: RxDocument shape is narrow
        .$.subscribe((row: any | null) => {
          setDoc(row ? (row.toJSON() as TodoDoc) : null);
        });
    });

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, [pageId]);

  return doc;
}

export async function updateTodoStatus(
  id: string,
  status: TodoDoc['status'],
): Promise<void> {
  const db = await getDatabase();
  const doc = await db.collections.todos.findOne(id).exec();
  if (!doc) return;
  const now = new Date().toISOString();
  await doc.patch({
    status,
    updated_at: now,
    completed_at: status === 'done' || status === 'archived' ? now : null,
  });
}

export async function updateTodoParent(
  id: string,
  parentPageId: string | null,
): Promise<void> {
  const db = await getDatabase();
  const doc = await db.collections.todos.findOne(id).exec();
  if (!doc) return;
  await doc.patch({
    parent_page_id: parentPageId,
    updated_at: new Date().toISOString(),
  });
}
