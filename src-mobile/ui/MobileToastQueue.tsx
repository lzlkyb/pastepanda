import { createContext, Fragment, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MobileToastEntry {
  id: string;
  identity: string;
  render: () => ReactNode;
  dismiss: () => void;
}

export interface MobileToastQueue {
  enqueue: (entry: MobileToastEntry) => void;
  remove: (id: string) => void;
  finish: (id: string) => void;
}

const QueueContext = createContext<MobileToastQueue | null>(null);
const WAITING_LIMIT = 3;
const WAITING_TTL = 20_000;

interface ToastGroup {
  identity: string;
  queuedAt: number;
  entries: MobileToastEntry[];
}

export function useMobileToastQueue() { return useContext(QueueContext); }

export function MobileToastProvider({ children }: { children: ReactNode }) {
  const groups = useRef<ToastGroup[]>([]);
  const [current, setCurrent] = useState<ToastGroup[]>([]);
  const queue = useMemo<MobileToastQueue>(() => {
    // Check age on queue operations, without keeping a background polling timer.
    // The active result retains its own paused reading timer and never expires here.
    const prune = (discarded: MobileToastEntry[]) => {
      const now = Date.now();
      groups.current = groups.current.filter((group, index) => {
        if (index === 0 || now - group.queuedAt < WAITING_TTL) return true;
        discarded.push(...group.entries);
        return false;
      });
    };
    const publish = (discarded: MobileToastEntry[]) => {
      setCurrent([...groups.current]);
      // Commit registry changes first so a callback re-entering finish/remove is safe.
      // Never invoke a business callback from a React state updater.
      discarded.forEach(entry => entry.dismiss());
    };
    return {
      enqueue(entry) {
        const discarded: MobileToastEntry[] = [];
        const previousIndex = groups.current.findIndex(group => group.entries.some(item => item.id === entry.id));
        const previous = groups.current[previousIndex];
        if (previous?.identity === entry.identity) {
          previous.entries = previous.entries.map(item => item.id === entry.id ? entry : item);
        } else {
          const keepsPrevious = previous && previous.entries.length > 1;
          if (previous) {
            previous.entries = previous.entries.filter(item => item.id !== entry.id);
            if (!keepsPrevious) groups.current.splice(previousIndex, 1);
          }
          const duplicate = groups.current.find(group => group.identity === entry.identity);
          if (duplicate) duplicate.entries.push(entry);
          else {
            const position = previous && !keepsPrevious ? previousIndex : groups.current.length;
            groups.current.splice(position, 0, { identity: entry.identity, queuedAt: Date.now(), entries: [entry] });
          }
        }
        prune(discarded);
        // Prefer recent outcomes when a burst fills the waiting queue.
        if (groups.current.length > WAITING_LIMIT + 1) {
          const dropped = groups.current.splice(1, groups.current.length - WAITING_LIMIT - 1);
          discarded.push(...dropped.flatMap(group => group.entries));
        }
        publish(discarded);
      },
      remove(id) {
        const discarded: MobileToastEntry[] = [];
        // Unregister before expiry handling: an unmounted owner receives no callback.
        groups.current = groups.current.map(group => ({ ...group, entries: group.entries.filter(item => item.id !== id) }));
        prune(discarded);
        groups.current = groups.current.filter(group => group.entries.length > 0);
        publish(discarded);
      },
      finish(id) {
        const discarded: MobileToastEntry[] = [];
        prune(discarded);
        const group = groups.current.find(item => item.entries.some(entry => entry.id === id));
        if (group) {
          groups.current = groups.current.filter(item => item !== group);
          discarded.push(...group.entries);
        }
        publish(discarded);
      },
    };
  }, []);
  const active = current[0];
  return <QueueContext.Provider value={queue}>{children}
    {active && createPortal(<Fragment key={active.identity}>{active.entries[0].render()}</Fragment>, document.body)}
  </QueueContext.Provider>;
}
