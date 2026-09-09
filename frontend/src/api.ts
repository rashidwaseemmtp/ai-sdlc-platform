/**
 * The API client.
 *
 * Two functions and one hook. Everything the dashboard knows comes through `request`, so an error
 * is handled in one place and every screen reports a failure the same way.
 */

import { useCallback, useEffect, useState } from 'react';

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error((body as { error?: string } | null)?.error ?? `${response.status} ${response.statusText}`);
  }
  return body as T;
}

export const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const put = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });

export const del = <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' });

/**
 * Fetch on mount and whenever `path` changes.
 *
 * `pollMs` exists because the pipeline moves on its own: a project page that does not refresh
 * looks broken while the runner is working.
 */
export function useApi<T>(path: string | null, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);

  const reload = useCallback(async () => {
    if (path === null) return;
    try {
      setData(await request<T>(path));
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
    if (!pollMs) return;
    const timer = setInterval(() => void reload(), pollMs);
    return () => clearInterval(timer);
  }, [reload, pollMs]);

  return { data, error, loading, reload };
}
