import { useMemo } from 'react';

interface VsCodeApiLike {
  postMessage: (message: unknown) => void;
  setState: (state: unknown) => void;
  getState: <T = unknown>() => T | undefined;
}

declare global {
  function acquireVsCodeApi(): VsCodeApiLike;
}

const fallbackApi: VsCodeApiLike = {
  postMessage: () => undefined,
  setState: () => undefined,
  getState: () => undefined,
};

export function useVSCodeAPI(): VsCodeApiLike {
  return useMemo(() => {
    if (typeof acquireVsCodeApi === 'function') {
      return acquireVsCodeApi();
    }

    return fallbackApi;
  }, []);
}
