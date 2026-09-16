"use client";

import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { type ViewMode, type ViewPage, viewModeCookieName } from "../lib/presentation/view-mode";
import { neutralLinkButtonClassName } from "./control-styles";

interface PageViewContextValue {
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
  revealAdvanced: (targetId: string) => void;
  controlRef: RefObject<HTMLFieldSetElement | null>;
}

const PageViewContext = createContext<PageViewContextValue | null>(null);

export function useViewMode(): { mode: ViewMode; setMode: (mode: ViewMode) => void } {
  const context = useContext(PageViewContext);
  if (!context) {
    throw new Error("useViewMode must be used inside PageView.");
  }
  return { mode: context.mode, setMode: context.setMode };
}

const selectedLabelClassName =
  "inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-accent bg-accent-soft px-3.5 py-2.5 text-sm font-semibold text-accent ring-accent has-[:focus-visible]:ring-2";
const unselectedLabelClassName =
  "inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-control-border bg-surface px-3.5 py-2.5 text-sm font-semibold text-muted-strong ring-accent has-[:focus-visible]:ring-2";

export function PageView({
  page,
  initialMode,
  children,
}: {
  page: ViewPage;
  initialMode: ViewMode;
  children: ReactNode;
}) {
  const [mode, setMode] = useState(initialMode);
  const controlRef = useRef<HTMLFieldSetElement>(null);
  const revealTargetIdRef = useRef<string | null>(null);
  const returnFocusRef = useRef(false);

  const switchMode = (nextMode: ViewMode) => {
    if (nextMode === mode) {
      return;
    }
    // biome-ignore lint/suspicious/noDocumentCookie: The view preference is a plain client-side cookie write by design; no server action or request is wanted.
    document.cookie = `${viewModeCookieName(page)}=${nextMode}; Path=/; SameSite=Lax; Max-Age=31536000`;
    if (nextMode === "basic") {
      const active = document.activeElement;
      returnFocusRef.current =
        active instanceof Element && active.closest("[data-advanced-only]") !== null;
    }
    setMode(nextMode);
  };

  const revealAdvanced = (targetId: string) => {
    if (mode === "advanced") {
      document.getElementById(targetId)?.focus();
      return;
    }
    revealTargetIdRef.current = targetId;
    switchMode("advanced");
  };

  useEffect(() => {
    if (mode === "advanced") {
      const targetId = revealTargetIdRef.current;
      if (!targetId) {
        return;
      }
      revealTargetIdRef.current = null;
      document.getElementById(targetId)?.focus();
      return;
    }
    if (!returnFocusRef.current) {
      return;
    }
    returnFocusRef.current = false;
    controlRef.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
  }, [mode]);

  const contextValue: PageViewContextValue = {
    mode,
    setMode: switchMode,
    revealAdvanced,
    controlRef,
  };

  return (
    <PageViewContext.Provider value={contextValue}>
      <fieldset className="mb-4" ref={controlRef}>
        <legend className="text-xs font-bold uppercase text-muted">View</legend>
        <div className="flex flex-wrap items-center gap-2">
          <label className={mode === "basic" ? selectedLabelClassName : unselectedLabelClassName}>
            <input
              checked={mode === "basic"}
              className="sr-only"
              name={`view-${page}`}
              onChange={() => switchMode("basic")}
              type="radio"
              value="basic"
            />
            Basic
          </label>
          <label
            className={mode === "advanced" ? selectedLabelClassName : unselectedLabelClassName}
          >
            <input
              checked={mode === "advanced"}
              className="sr-only"
              name={`view-${page}`}
              onChange={() => switchMode("advanced")}
              type="radio"
              value="advanced"
            />
            Advanced
          </label>
        </div>
      </fieldset>
      {children}
    </PageViewContext.Provider>
  );
}

/**
 * Without a PageView context the surface does not participate in public view control (admin or
 * authenticated renders, embedded uses), so its content stays detailed instead of hiding.
 */
export function AdvancedOnly({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const context = useContext(PageViewContext);
  return (
    <div
      className={className}
      data-advanced-only="true"
      hidden={context !== null && context.mode === "basic"}
      id={id}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

/** Basic content stays mounted across view switches and remains visible outside PageView. */
export function BasicOnly({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const context = useContext(PageViewContext);
  return (
    <div
      className={className}
      data-basic-only="true"
      hidden={context?.mode === "advanced"}
      id={id}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

export function RevealAdvancedLink({
  targetId,
  className,
  children,
}: {
  targetId: string;
  className?: string;
  children: ReactNode;
}) {
  const context = useContext(PageViewContext);
  if (!context) {
    // Without a public view control there is no Advanced level to reveal; like `AdvancedOnly`,
    // the link degrades to plain content instead of throwing or hiding anything.
    return <span className={className}>{children}</span>;
  }
  return (
    <button
      className={className ?? neutralLinkButtonClassName}
      onClick={() => context.revealAdvanced(targetId)}
      type="button"
    >
      {children}
    </button>
  );
}
