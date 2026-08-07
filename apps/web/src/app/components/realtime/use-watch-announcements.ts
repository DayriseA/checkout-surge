"use client";

import { useEffect, useRef, useState } from "react";
import type { RealtimeConnectionStatus } from "../../lib/presentation/freshness";
import {
  composePoliteWatchAnnouncement,
  deriveWatchAnnouncements,
  politeAnnouncementMinimumIntervalMs,
  type WatchAnnouncements,
  type WatchAnnouncementTracking,
} from "../../lib/presentation/watch-announcements";
import type { WatchComposition } from "../../lib/presentation/watch-composition";

// Alternating a silent word joiner forces repeated terminal copy to mutate without speaking an ID.
const silentTerminalMutationSuffix = "\u2060";

export function useWatchAnnouncements(
  composition: WatchComposition,
  transportStatus: RealtimeConnectionStatus,
  retriesExhausted: boolean,
): { politeMessage: string; assertiveMessage: string } {
  const trackingRef = useRef<WatchAnnouncementTracking | null>(null);
  const lastPoliteAnnouncementAtRef = useRef<number | null>(null);
  const queuedAnnouncementsRef = useRef<WatchAnnouncements>({});
  const terminalMutationRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [messages, setMessages] = useState({ politeMessage: "", assertiveMessage: "" });

  useEffect(() => {
    const result = deriveWatchAnnouncements(trackingRef.current, {
      composition,
      retriesExhausted,
      transportStatus,
    });
    trackingRef.current = result.tracking;

    if (!retriesExhausted) {
      setMessages((current) =>
        current.assertiveMessage === "" ? current : { ...current, assertiveMessage: "" },
      );
    }
    if (result.announcements.assertive) {
      cancelQueuedAnnouncement(timerRef, queuedAnnouncementsRef);
      setMessages((current) => ({
        ...current,
        assertiveMessage: result.announcements.assertive ?? "",
      }));
      return;
    }
    if (result.announcements.terminal) {
      cancelQueuedAnnouncement(timerRef, queuedAnnouncementsRef);
      lastPoliteAnnouncementAtRef.current = Date.now();
      terminalMutationRef.current = !terminalMutationRef.current;
      const terminalMessage =
        result.announcements.terminal +
        (terminalMutationRef.current ? silentTerminalMutationSuffix : "");
      setMessages((current) => ({
        ...current,
        politeMessage: terminalMessage,
      }));
      return;
    }

    const politeAnnouncements: WatchAnnouncements = {
      ...(result.announcements.connection ? { connection: result.announcements.connection } : {}),
      ...(result.announcements.lifecycle ? { lifecycle: result.announcements.lifecycle } : {}),
      ...(result.announcements.milestone ? { milestone: result.announcements.milestone } : {}),
    };
    const politeMessage = composePoliteWatchAnnouncement(politeAnnouncements);
    if (politeMessage === "") return;

    const now = Date.now();
    const lastAnnouncementAt = lastPoliteAnnouncementAtRef.current;
    if (
      lastAnnouncementAt === null ||
      now - lastAnnouncementAt >= politeAnnouncementMinimumIntervalMs
    ) {
      lastPoliteAnnouncementAtRef.current = now;
      setMessages((current) => ({ ...current, politeMessage }));
      return;
    }

    queuedAnnouncementsRef.current = {
      ...queuedAnnouncementsRef.current,
      ...politeAnnouncements,
    };
    if (timerRef.current !== null) return;
    timerRef.current = setTimeout(
      () => {
        timerRef.current = null;
        const queuedMessage = composePoliteWatchAnnouncement(queuedAnnouncementsRef.current);
        queuedAnnouncementsRef.current = {};
        if (queuedMessage === "") return;
        lastPoliteAnnouncementAtRef.current = Date.now();
        setMessages((current) => ({ ...current, politeMessage: queuedMessage }));
      },
      politeAnnouncementMinimumIntervalMs - (now - lastAnnouncementAt),
    );
  }, [composition, retriesExhausted, transportStatus]);

  useEffect(() => () => cancelQueuedAnnouncement(timerRef, queuedAnnouncementsRef), []);

  return messages;
}

function cancelQueuedAnnouncement(
  timerRef: { current: ReturnType<typeof setTimeout> | null },
  queuedAnnouncementsRef: { current: WatchAnnouncements },
) {
  if (timerRef.current !== null) clearTimeout(timerRef.current);
  timerRef.current = null;
  queuedAnnouncementsRef.current = {};
}
