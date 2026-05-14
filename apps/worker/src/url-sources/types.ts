// Shared types for the url-source ingestion pipeline. Mirrors the
// upload-ingestion type set (apps/worker/src/uploads/types.ts) — same
// output shape so future genericization is a smaller refactor.
//
// Same snippet shape as uploads: just text, no turn_id. URLs aren't
// turn-structured.

export interface TouchedPage {
  slug: string;
}

export interface NewPage {
  proposed_slug: string;
  proposed_title: string;
  type: string;
  proposed_parent_slug: string | null;
}

export interface FlashUrlSourceCandidateResult {
  touched_pages: TouchedPage[];
  new_pages: NewPage[];
  dump?: { reason: string };
}

export interface UrlSourceSnippetWrite {
  text: string;
}

export interface UrlSourceSectionRef {
  id?: string;
  title?: string;
  content?: string;
  snippets?: UrlSourceSnippetWrite[];
}

export interface UrlSourceNewSectionWrite {
  title?: string;
  content: string;
  snippets: UrlSourceSnippetWrite[];
}

export interface UrlSourcePageCreate {
  slug: string;
  title: string;
  type: string;
  parent_slug?: string;
  agent_abstract: string;
  abstract?: string;
  sections: UrlSourceNewSectionWrite[];
  todo_parent_slug?: string;
}

export interface UrlSourcePageUpdate {
  slug: string;
  agent_abstract: string;
  abstract?: string;
  sections?: UrlSourceSectionRef[];
  parent_slug?: string | null;
}

export interface UrlSourceSkippedClaim {
  claim?: string;
  reason: string;
}

export interface ProUrlSourceFanOutResult {
  creates: UrlSourcePageCreate[];
  updates: UrlSourcePageUpdate[];
  skipped: UrlSourceSkippedClaim[];
}
