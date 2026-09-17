"use client";

import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { type ViewMode, viewModeCookieName } from "../lib/presentation/view-mode";
import { neutralLinkButtonClassName } from "./control-styles";

interface ViewPreferenceContextValue {
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
  participating: boolean;
  register: () => () => void;
  switchRef: RefObject<HTMLButtonElement | null>;
}

interface PageViewContextValue {
  mode: ViewMode;
  revealAdvanced: (targetId: string) => void;
}

const ViewPreferenceContext = createContext<ViewPreferenceContextValue | null>(null);
const PageViewContext = createContext<PageViewContextValue | null>(null);

function focusAdvancedTarget(targetId: string) {
  const target = document.getElementById(targetId);
  target?.focus({ preventScroll: true });
  // Align the section start using the document's sticky-header scroll padding.
  target?.scrollIntoView({ block: "start", behavior: "instant" });
}

function useViewPreference() {
  const context = useContext(ViewPreferenceContext);
  if (!context) {
    throw new Error("View preference controls must be used inside ViewPreferenceProvider.");
  }
  return context;
}

export function ViewPreferenceProvider({
  initialMode,
  children,
}: {
  initialMode: ViewMode;
  children: ReactNode;
}) {
  const [mode, setModeState] = useState(initialMode);
  const [participantCount, setParticipantCount] = useState(0);
  const switchRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(false);

  const setMode = useCallback(
    (nextMode: ViewMode) => {
      if (nextMode === mode) return;
      if (nextMode === "basic") {
        const active = document.activeElement;
        returnFocusRef.current =
          active instanceof Element && active.closest("[data-advanced-only]") !== null;
      }
      // biome-ignore lint/suspicious/noDocumentCookie: This plain preference needs no server action.
      document.cookie = `${viewModeCookieName}=${nextMode}; Path=/; SameSite=Lax; Max-Age=31536000`;
      setModeState(nextMode);
    },
    [mode],
  );

  const register = useCallback(() => {
    setParticipantCount((count) => count + 1);
    return () => setParticipantCount((count) => count - 1);
  }, []);

  useEffect(() => {
    if (mode === "basic" && returnFocusRef.current) {
      returnFocusRef.current = false;
      switchRef.current?.focus();
    }
  }, [mode]);

  return (
    <ViewPreferenceContext.Provider
      value={{ mode, participating: participantCount > 0, register, setMode, switchRef }}
    >
      {children}
    </ViewPreferenceContext.Provider>
  );
}

export function ViewModeSwitch() {
  const { mode, participating, setMode, switchRef } = useViewPreference();
  if (!participating) return null;

  const advanced = mode === "advanced";
  return (
    <button
      aria-checked={advanced}
      className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-2 py-2 text-sm font-semibold text-ink ring-accent focus-visible:outline-none focus-visible:ring-2"
      onClick={() => setMode(advanced ? "basic" : "advanced")}
      ref={switchRef}
      role="switch"
      type="button"
    >
      <span>Advanced</span>
      <span
        aria-hidden="true"
        className={`flex h-6 w-11 items-center rounded-full border px-0.5 transition-colors ${
          advanced
            ? "justify-end border-accent bg-accent"
            : "justify-start border-control-border bg-surface-muted"
        }`}
      >
        <span className="h-4.5 w-4.5 rounded-full bg-surface shadow-sm" />
      </span>
    </button>
  );
}

export function PageView({ children }: { children: ReactNode }) {
  const preference = useContext(ViewPreferenceContext);
  const mode = preference?.mode ?? "basic";
  const register = preference?.register;
  const setMode = preference?.setMode;
  const revealTargetIdRef = useRef<string | null>(null);

  useEffect(() => register?.(), [register]);

  const revealAdvanced = (targetId: string) => {
    if (mode === "advanced") {
      focusAdvancedTarget(targetId);
      return;
    }
    revealTargetIdRef.current = targetId;
    setMode?.("advanced");
  };

  useEffect(() => {
    if (mode === "advanced") {
      const targetId = revealTargetIdRef.current;
      if (!targetId) {
        return;
      }
      revealTargetIdRef.current = null;
      focusAdvancedTarget(targetId);
      return;
    }
  }, [mode]);

  const contextValue: PageViewContextValue = {
    mode,
    revealAdvanced,
  };

  return <PageViewContext.Provider value={contextValue}>{children}</PageViewContext.Provider>;
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

/**
 * Reveals an Advanced-only hash target on arrival and on later hash changes only. The latest
 * `revealAdvanced` is read through a ref so a mode switch never re-applies the standing hash and
 * overrides the visitor's explicit choice.
 */
export function RevealAdvancedHashTarget() {
  const context = useContext(PageViewContext);
  const revealAdvancedRef = useRef(context?.revealAdvanced);
  revealAdvancedRef.current = context?.revealAdvanced;

  useEffect(() => {
    const revealHashTarget = () => {
      const targetId = window.location.hash.slice(1);
      if (!targetId) return;
      const target = document.getElementById(targetId);
      if (target?.closest("[data-advanced-only]")) {
        revealAdvancedRef.current?.(targetId);
      }
    };

    revealHashTarget();
    window.addEventListener("hashchange", revealHashTarget);
    return () => window.removeEventListener("hashchange", revealHashTarget);
  }, []);

  return null;
}
