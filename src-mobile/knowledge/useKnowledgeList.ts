import { useCallback, useEffect, useRef, useState } from "react";
import { mobileKnowledgeList, type MobileKnowledgeListOptions, type MobileNoteSummary } from "@/lib/api/mobileKnowledge";
import { knowledgeErrorText } from "@/lib/utils";

export function useKnowledgeList(active: boolean, options: MobileKnowledgeListOptions) {
  const [items, setItems] = useState<MobileNoteSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [cancelled, setCancelled] = useState(false);
  const generation = useRef(0);
  const loadingMore = useRef(false);
  const mounted = useRef(true);
  const key = JSON.stringify(options);
  const current = useRef(options); current.current = options;
  const scope = useRef("");
  const rows = useRef<MobileNoteSummary[]>([]);
  const loadedRefresh = useRef(-1);
  const nextOffset = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    const request = ++generation.current;
    loadingMore.current = false;
    if (!active) { setLoading(false); return; }
    if (scope.current === key && loadedRefresh.current === refreshKey) return;
    const sameScope = scope.current === key;
    const pageCount = sameScope ? Math.max(1, Math.ceil(nextOffset.current / 20)) : 1;
    if (!sameScope) { scope.current = ""; rows.current = []; setItems([]); setHasMore(false); nextOffset.current = 0; }
    setLoading(true); setError(""); setCancelled(false);
    const timer = setTimeout(() => {
      const read = async () => {
        const collected: MobileNoteSummary[] = [];
        let offset = 0, has_more = false;
        // Refresh the loaded range, so returning from page two never truncates it.
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
          if (!mounted.current || generation.current !== request) return null;
          const page = await mobileKnowledgeList({ ...current.current, offset });
          offset += page.items.length; has_more = page.has_more;
          collected.push(...page.items.filter(item => !collected.some(note => note.id === item.id)));
          if (!has_more || !page.items.length) break;
        }
        return { items: collected, has_more, offset };
      };
      void read().then(page => {
        if (!page) return;
        if (!mounted.current || generation.current !== request) return;
        scope.current = key; loadedRefresh.current = refreshKey;
        rows.current = page.items; nextOffset.current = page.offset;
        setItems(page.items); setHasMore(page.has_more);
      }).catch(cause => {
        if (mounted.current && generation.current === request) setError(knowledgeErrorText(cause));
      }).finally(() => {
        if (mounted.current && generation.current === request) setLoading(false);
      });
    }, options.query ? 200 : 0);
    return () => { clearTimeout(timer); generation.current++; };
  }, [active, key, refreshKey]);
  const refresh = useCallback(() => setRefreshKey(value => value + 1), []);
  const more = useCallback(async () => {
    if (!active || loading || loadingMore.current || !hasMore || scope.current !== key) return;
    loadingMore.current = true; setLoading(true); setError(""); setCancelled(false);
    const request = generation.current;
    try {
      const page = await mobileKnowledgeList({ ...current.current, offset: nextOffset.current });
      if (!mounted.current || generation.current !== request) return;
      nextOffset.current += page.items.length;
      rows.current = [...rows.current, ...page.items.filter(item => !rows.current.some(note => note.id === item.id))];
      setItems(rows.current);
      setHasMore(page.has_more);
    } catch (cause) {
      if (mounted.current && generation.current === request) setError(knowledgeErrorText(cause));
    } finally {
      if (mounted.current && generation.current === request) { loadingMore.current = false; setLoading(false); }
    }
  }, [active, loading, hasMore, items.length, key]);
  const cancel = useCallback(() => { generation.current++; loadingMore.current = false; setLoading(false); setCancelled(true); }, []);
  return { items: scope.current === key ? items : [], hasMore: scope.current === key && hasMore, loading, error, cancelled, refresh, more, cancel };
}
