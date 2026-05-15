// Hooks for the Storage tile. Plain state + useEffect (matches the
// Automations tile pattern — no React Query in the project).
//
// Combined Storage feed: uploads + URL sources merged + sorted by
// created_at. The tile renders them in one chronological list so the
// user's mental model is "stuff I added to Storage," regardless of
// whether it's a file or a URL.
//
// Discriminator field is `family` (upload | url_source) NOT `kind` —
// the inner `kind` field on each row carries the source-specific
// kind (pdf/markdown/plain/docx for uploads;
// web_article/pdf/reddit_thread for url_sources). Renaming the
// family discriminator avoids collision with that inner field.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type UploadRow,
  type UrlSourceRow,
  listUploads,
  listUrlSources,
} from './api';

export type StorageItem =
  | ({ family: 'upload' } & UploadRow)
  | ({ family: 'url_source' } & UrlSourceRow);

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useStorageItems(): FetchState<StorageItem[]> {
  const [uploads, setUploads] = useState<UploadRow[] | null>(null);
  const [urlSources, setUrlSources] = useState<UrlSourceRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, s] = await Promise.all([listUploads(), listUrlSources()]);
      setUploads(u);
      setUrlSources(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const data = useMemo<StorageItem[] | null>(() => {
    if (uploads === null && urlSources === null) return null;
    const merged: StorageItem[] = [
      ...(uploads ?? []).map<StorageItem>((u) => ({ family: 'upload', ...u })),
      ...(urlSources ?? []).map<StorageItem>((s) => ({ family: 'url_source', ...s })),
    ];
    merged.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
    return merged;
  }, [uploads, urlSources]);

  return { data, loading, error, refresh };
}
