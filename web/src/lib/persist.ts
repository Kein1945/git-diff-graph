import { useEffect, useState } from 'react';

const PREFIX = 'git-diff-graph:';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** `useState` that survives page reloads via localStorage (JSON-serialisable values only). */
export function usePersistentState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => read(key, fallback));
  useEffect(() => {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // storage unavailable (private mode, quota) — keep in-memory state only
    }
  }, [key, value]);
  return [value, setValue] as const;
}
