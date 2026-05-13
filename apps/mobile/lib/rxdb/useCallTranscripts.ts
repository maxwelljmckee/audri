// Reactive RxDB query hooks for call_transcripts.
//
//   useCallTranscripts()           — all chats sorted by started_at DESC.
//                                    Drives the Chat History list.
//   useCallTranscript(id)          — one chat by id. Drives the detail view.
//   useActiveIngestionTranscripts() — chats with ingestion_status pending or
//                                    running. Drives the Notes pending banner.
//   useFailedIngestionTranscripts() — chats with ingestion_status='failed' or
//                                    'partial'. Drives the failure-state
//                                    banner with retry CTA. Partial = the
//                                    agent-scope pass wrote but the user-
//                                    scope pass (the visible wiki pages) did
//                                    not; retry-ingest re-runs user-scope
//                                    only.
//   useOverCapTranscripts()         — chats with ingestion_status =
//                                    'skipped_over_cap'. Distinct from
//                                    failed: not a worker error, but the
//                                    user crossed their monthly spending
//                                    cap before /end or worker pickup.
//                                    Drives a separate banner with a
//                                    "raise limit" deep-link rather than
//                                    a retry CTA.
//   useSectionsByTranscript(id)    — wiki_section_transcripts rows for a
//                                    given transcript. Drives the chat
//                                    detail's cross-references panel.

import { useEffect, useState } from 'react';
import { getDatabase } from './database';
import type { CallTranscriptDoc, WikiSectionTranscriptDoc } from './schemas';

const ACTIVE_STATUSES = ['pending', 'running'] as const;
const FAILED_STATUSES = ['failed', 'partial'] as const;

export function useCallTranscripts(): CallTranscriptDoc[] {
  const [docs, setDocs] = useState<CallTranscriptDoc[]>([]);

  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined;
    let cancelled = false;

    void getDatabase().then((db) => {
      if (cancelled) return;
      sub = db.collections.call_transcripts
        .find({ sort: [{ started_at: 'desc' }] })
        // biome-ignore lint/suspicious/noExplicitAny: RxDocument shape is narrow
        .$.subscribe((rows: any[]) => {
          setDocs(rows.map((d) => d.toJSON() as CallTranscriptDoc));
        });
    });

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, []);

  return docs;
}

export function useCallTranscript(id: string | null): CallTranscriptDoc | null {
  const [doc, setDoc] = useState<CallTranscriptDoc | null>(null);

  useEffect(() => {
    if (!id) {
      setDoc(null);
      return;
    }
    let sub: { unsubscribe: () => void } | undefined;
    let cancelled = false;

    void getDatabase().then((db) => {
      if (cancelled) return;
      sub = db.collections.call_transcripts
        .findOne(id)
        // biome-ignore lint/suspicious/noExplicitAny: RxDocument shape is narrow
        .$.subscribe((row: any | null) => {
          setDoc(row ? (row.toJSON() as CallTranscriptDoc) : null);
        });
    });

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, [id]);

  return doc;
}

export function useActiveIngestionTranscripts(): CallTranscriptDoc[] {
  const [docs, setDocs] = useState<CallTranscriptDoc[]>([]);

  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined;
    let cancelled = false;

    void getDatabase().then((db) => {
      if (cancelled) return;
      sub = db.collections.call_transcripts
        .find({
          selector: { ingestion_status: { $in: [...ACTIVE_STATUSES] } },
          sort: [{ started_at: 'desc' }],
        })
        // biome-ignore lint/suspicious/noExplicitAny: same as above
        .$.subscribe((rows: any[]) => {
          setDocs(rows.map((d) => d.toJSON() as CallTranscriptDoc));
        });
    });

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, []);

  return docs;
}

export function useFailedIngestionTranscripts(): CallTranscriptDoc[] {
  const [docs, setDocs] = useState<CallTranscriptDoc[]>([]);

  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined;
    let cancelled = false;

    void getDatabase().then((db) => {
      if (cancelled) return;
      sub = db.collections.call_transcripts
        .find({
          selector: { ingestion_status: { $in: [...FAILED_STATUSES] } },
          sort: [{ started_at: 'desc' }],
        })
        // biome-ignore lint/suspicious/noExplicitAny: same as above
        .$.subscribe((rows: any[]) => {
          setDocs(rows.map((d) => d.toJSON() as CallTranscriptDoc));
        });
    });

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, []);

  return docs;
}

export function useOverCapTranscripts(): CallTranscriptDoc[] {
  const [docs, setDocs] = useState<CallTranscriptDoc[]>([]);

  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined;
    let cancelled = false;

    void getDatabase().then((db) => {
      if (cancelled) return;
      sub = db.collections.call_transcripts
        .find({
          selector: { ingestion_status: 'skipped_over_cap' },
          sort: [{ started_at: 'desc' }],
        })
        // biome-ignore lint/suspicious/noExplicitAny: same as above
        .$.subscribe((rows: any[]) => {
          setDocs(rows.map((d) => d.toJSON() as CallTranscriptDoc));
        });
    });

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, []);

  return docs;
}

export function useSectionsByTranscript(transcriptId: string | null): WikiSectionTranscriptDoc[] {
  const [docs, setDocs] = useState<WikiSectionTranscriptDoc[]>([]);

  useEffect(() => {
    if (!transcriptId) {
      setDocs([]);
      return;
    }
    let sub: { unsubscribe: () => void } | undefined;
    let cancelled = false;

    void getDatabase().then((db) => {
      if (cancelled) return;
      sub = db.collections.wiki_section_transcripts
        .find({
          selector: { transcript_id: transcriptId },
          sort: [{ cited_at: 'asc' }],
        })
        // biome-ignore lint/suspicious/noExplicitAny: same as above
        .$.subscribe((rows: any[]) => {
          setDocs(rows.map((d) => d.toJSON() as WikiSectionTranscriptDoc));
        });
    });

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, [transcriptId]);

  return docs;
}
