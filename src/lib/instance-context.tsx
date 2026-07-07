"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  ALL_INSTANCE_SLUGS,
  BISON_INSTANCES,
  DEFAULT_GROUP,
  instancesInGroup,
  type BisonGroup,
  type BisonInstance,
  type BisonInstanceSlug,
  type BisonTier,
} from "./bison-instances";

type TierFilter = "all" | BisonTier;
/** "all" = master view across Group 1 + Group 2. */
export type GroupFilter = "all" | BisonGroup;

interface InstanceContextValue {
  group: GroupFilter;
  tier: TierFilter;
  setGroup: (g: GroupFilter) => void;
  setTier: (t: TierFilter) => void;
  /** Instances matched by current (group, tier) — up to all 4 when group is "all". */
  instances: BisonInstance[];
  /** Comma-separated slug list, useful as a stable cache key. */
  instancesKey: string;
  /** Builds a `?instances=<csv>` query string fragment (without the leading ?). */
  instancesQuery: string;
}

const InstanceContext = createContext<InstanceContextValue | null>(null);

const STORAGE_KEY = "leadsync.instance";

function loadFromStorage(): { group: GroupFilter; tier: TierFilter } {
  if (typeof window === "undefined") return { group: DEFAULT_GROUP, tier: "all" };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { group: DEFAULT_GROUP, tier: "all" };
    const parsed = JSON.parse(raw) as { group?: number | string; tier?: string };
    const group: GroupFilter = parsed.group === "all" ? "all" : parsed.group === 2 ? 2 : 1;
    const tier: TierFilter = parsed.tier === "b2b" || parsed.tier === "b2c" ? parsed.tier : "all";
    return { group, tier };
  } catch {
    return { group: DEFAULT_GROUP, tier: "all" };
  }
}

export function InstanceProvider({ children }: { children: React.ReactNode }) {
  const [group, setGroupState] = useState<GroupFilter>(DEFAULT_GROUP);
  const [tier, setTierState] = useState<TierFilter>("all");

  // Hydrate from localStorage on mount
  useEffect(() => {
    const saved = loadFromStorage();
    setGroupState(saved.group);
    setTierState(saved.tier);
  }, []);

  const persist = useCallback((g: GroupFilter, t: TierFilter) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ group: g, tier: t }));
    } catch {
      /* ignore quota errors */
    }
  }, []);

  const setGroup = useCallback(
    (g: GroupFilter) => {
      setGroupState(g);
      persist(g, tier);
    },
    [tier, persist],
  );

  const setTier = useCallback(
    (t: TierFilter) => {
      setTierState(t);
      persist(group, t);
    },
    [group, persist],
  );

  const instances = useMemo(() => {
    const groupInstances = group === "all"
      ? ALL_INSTANCE_SLUGS.map((s) => BISON_INSTANCES[s])
      : instancesInGroup(group);
    if (tier === "all") return groupInstances;
    return groupInstances.filter((i) => i.tier === tier);
  }, [group, tier]);

  const instancesKey = useMemo(() => instances.map((i) => i.slug).join(","), [instances]);
  const instancesQuery = useMemo(() => `instances=${instancesKey}`, [instancesKey]);

  const value = useMemo<InstanceContextValue>(
    () => ({ group, tier, setGroup, setTier, instances, instancesKey, instancesQuery }),
    [group, tier, setGroup, setTier, instances, instancesKey, instancesQuery],
  );

  return <InstanceContext.Provider value={value}>{children}</InstanceContext.Provider>;
}

export function useInstance(): InstanceContextValue {
  const ctx = useContext(InstanceContext);
  if (!ctx) {
    throw new Error("useInstance must be used inside <InstanceProvider>");
  }
  return ctx;
}

/** Lookup helper exposed for non-React contexts (rarely needed). */
export function instanceLabel(slug: BisonInstanceSlug): string {
  return BISON_INSTANCES[slug].label;
}
