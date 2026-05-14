// Shared types for the upload-ingestion pipeline. Mirrors the
// transcript-ingestion type set (apps/worker/src/ingestion/*.ts) so the
// commit + page-creation logic can share concepts, with one structural
// difference:
//
//   - Snippet citations don't carry a turn_id. Documents aren't
//     turn-structured; a snippet is just an excerpt of the source text.
//     wiki_section_uploads has no turn_id column.
//
// The fan-out result shape otherwise matches: creates + updates +
// skipped + tasks. We intentionally do NOT support cited_urls (no
// live-grounding for uploads) or todo_assignee='assistant' (uploads
// have no speaker persona).

export interface TouchedPage {
  slug: string;
}

export interface NewPage {
  proposed_slug: string;
  proposed_title: string;
  type: string;
  proposed_parent_slug: string | null;
}

export interface FlashUploadCandidateResult {
  touched_pages: TouchedPage[];
  new_pages: NewPage[];
  // Same escape hatch as transcript Flash: when the document is
  // genuinely substanceless (e.g. a one-line invoice header with no
  // semantic content), skip the Pro fan-out and commit nothing.
  dump?: { reason: string };
}

// Snippet shape for upload pipeline: just text. No turn_id (docs
// aren't turn-structured) and no per-snippet location yet (page
// numbers / heading anchors are a follow-up if/when the Storage
// detail UX needs them).
export interface UploadSnippetWrite {
  text: string;
}

export interface UploadSectionRef {
  id?: string;
  title?: string;
  content?: string;
  snippets?: UploadSnippetWrite[];
}

export interface UploadNewSectionWrite {
  title?: string;
  content: string;
  snippets: UploadSnippetWrite[];
}

export interface UploadPageCreate {
  slug: string;
  title: string;
  type: string;
  parent_slug?: string;
  agent_abstract: string;
  abstract?: string;
  sections: UploadNewSectionWrite[];
  // todo_parent_slug carries the same semantic as the transcript
  // pipeline for type='todo' creates: optional wiki page the todo
  // associates with. Default omit → "General" swimlane.
  todo_parent_slug?: string;
  // Uploads don't have an "assistant" speaker — only `user` here.
  // Field omitted from output schema; default is user.
}

export interface UploadPageUpdate {
  slug: string;
  agent_abstract: string;
  abstract?: string;
  sections?: UploadSectionRef[];
  parent_slug?: string | null;
}

export interface UploadSkippedClaim {
  claim?: string;
  reason: string;
}

// Same shape as the transcript pipeline. Document content frequently
// inspires "I should look into …" intentions when paired with the
// user's own notes-on-the-doc, but for v0.3.0 we keep the doc pipeline
// research-task-extraction-free — docs don't tend to phrase explicit
// commitments the way transcripts do. Leaving the type here in case we
// want to enable it later.
export interface UploadExtractedTask {
  kind: 'research';
  query: string;
  context_summary?: string;
}

export interface ProUploadFanOutResult {
  creates: UploadPageCreate[];
  updates: UploadPageUpdate[];
  skipped: UploadSkippedClaim[];
  tasks: UploadExtractedTask[];
}
