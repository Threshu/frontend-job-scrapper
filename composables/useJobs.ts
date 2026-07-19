import type { GroupDto } from "~~/server/api/groups/index.get";

export interface SourceInfo {
	source: string;
	displayName: string;
	needsBrowser: boolean;
}

export interface CompletedSource {
	source: string;
	fetched: number;
	newListings: number;
	newGroups: number;
	errors: string[];
	durationMs: number;
}

export interface ScrapeProgressData {
	running: boolean;
	startedAt: string | null;
	finishedAt: string | null;
	total: number;
	completed: CompletedSource[];
}

export interface JobFilters {
	status: string;
	hasVue: boolean;
	source: string;
	search: string;
	includeStale: boolean;
	hideNoise: boolean;
	vueInTitle: boolean;
	// 'core' (default) = primary+required, 'all' = also include "Vue mile widziane",
	// 'primary' = only Vue-in-title, 'mention' = only nice-to-have, '' = any/disabled.
	vueRelevance: 'core' | 'all' | 'primary' | 'required' | 'mention';
}

export const VUE_RELEVANCE_OPTIONS: { value: JobFilters['vueRelevance']; label: string }[] = [
	{ value: 'core', label: 'Vue jako stack (domyślne)' },
	{ value: 'primary', label: 'Tylko Vue w tytule' },
	{ value: 'required', label: 'Tylko Vue wymagane' },
	{ value: 'mention', label: 'Tylko Vue mile widziane' },
	{ value: 'all', label: 'Wszystko z Vue (z szumem)' },
];

export type SortBy = "relevance" | "newest";

export const SORT_OPTIONS: { value: SortBy; label: string }[] = [
	{ value: "relevance", label: "Trafność" },
	{ value: "newest", label: "Najnowsze" },
];

function bestPostedMs(g: GroupDto): number {
	return g.listings
		.filter((l) => l.postedAt)
		.reduce((max, l) => Math.max(max, new Date(l.postedAt!).getTime()), 0);
}

function bestSeenMs(g: GroupDto): number {
	return g.listings.reduce(
		(max, l) => Math.max(max, new Date(l.firstSeenAt).getTime()),
		0,
	);
}

function relevanceScore(g: GroupDto): number {
	let score = 0;

	// Vue w tytule = rola stricte dla Vue devów — najsilniejszy sygnał
	if (g.vueInTitle) score += 50;
	else if (g.vueRelevance === 'required') score += 25;
	else if (g.vueRelevance === 'mention') score += 5;
	else if (g.hasVue) score += 15;

	// Remote = szersza pula kandydatów, ale też więcej możliwości
	if (g.listings.some((l) => l.remote)) score += 12;

	// Pojawia się na wielu portalach = bardziej eksponowane ogłoszenie
	score += Math.min((g.listings.length - 1) * 5, 15);

	// Widełki = uczciwy pracodawca, który nie ukrywa budżetu
	if (g.bestSalary?.max != null) score += 8;

	// Świeżość (0–30 pkt): im nowsze postedAt, tym lepiej
	const postedMs = bestPostedMs(g);
	if (postedMs > 0) {
		const daysAgo = (Date.now() - postedMs) / 86_400_000;
		score += Math.max(0, 30 - daysAgo);
	} else {
		// fallback na firstSeenAt gdy portal nie podaje daty publikacji
		const seenMs = bestSeenMs(g);
		const daysAgo = (Date.now() - seenMs) / 86_400_000;
		score += Math.max(0, 20 - daysAgo);
	}

	return score;
}

export const STATUSES = [
	"new",
	"interested",
	"applied",
	"replied",
	"rejected",
	"hidden",
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
	new: "Nowa",
	interested: "Ciekawa",
	applied: "Zaaplikowano",
	replied: "Odpowiedź",
	rejected: "Odrzucona",
	hidden: "Ukryta",
};

export function useJobs() {
	const activeTab = useState<"active" | "applied" | "rejected">(
		"activeTab",
		() => "active",
	);
	const filters = useState<JobFilters>("filters", () => ({
		status: "new",
		hasVue: true,
		source: "",
		search: "",
		includeStale: false,
		hideNoise: true,
		vueInTitle: false,
		vueRelevance: "core",
	}));
	const sortBy = useState<SortBy>("sortBy", () => "relevance");
	const groups = useState<GroupDto[]>("groups", () => []);
	const loading = useState<boolean>("groupsLoading", () => false);

	const sortedGroups = computed(() => {
		const list = [...groups.value];
		if (sortBy.value === "newest") {
			return list.sort((a, b) => {
				const aMs = bestPostedMs(a) || bestSeenMs(a);
				const bMs = bestPostedMs(b) || bestSeenMs(b);
				return bMs - aMs;
			});
		}
		return list.sort((a, b) => relevanceScore(b) - relevanceScore(a));
	});

	async function refresh() {
		loading.value = true;
		try {
			const q: Record<string, string> = {};
			if (activeTab.value === "applied") {
				q.status = "applied";
			} else if (activeTab.value === "rejected") {
				q.status = "rejected";
			} else {
				if (filters.value.status) q.status = filters.value.status;
				if (filters.value.hasVue) q.hasVue = "1";
				if (filters.value.source) q.source = filters.value.source;
				if (filters.value.search) q.search = filters.value.search;
				if (filters.value.includeStale) q.includeStale = "1";
				if (filters.value.hideNoise) q.hideNoise = "1";
				if (filters.value.vueInTitle) q.vueInTitle = "1";
				if (filters.value.vueRelevance && filters.value.vueRelevance !== "all") {
					q.vueRelevance = filters.value.vueRelevance;
				}
			}
			const res = await $fetch<{ groups: GroupDto[] }>("/api/groups", {
				query: q,
			});
			groups.value = res.groups;
		} finally {
			loading.value = false;
		}
	}

	async function setStatus(id: number, status: Status) {
		await $fetch(`/api/groups/${id}/status`, {
			method: "PATCH",
			body: { status },
		});
		const g = groups.value.find((x) => x.id === id);
		if (g) {
			g.status = status;
			// Remove card from list if it no longer belongs to the current tab
			const staysInTab =
				(activeTab.value === "active" &&
					status !== "applied" &&
					status !== "rejected") ||
				(activeTab.value === "applied" && status === "applied") ||
				(activeTab.value === "rejected" && status === "rejected");
			if (!staysInTab) groups.value = groups.value.filter((x) => x.id !== id);
		}
	}

	async function setNotes(id: number, notes: string) {
		await $fetch(`/api/groups/${id}/notes`, {
			method: "PATCH",
			body: { notes },
		});
		const g = groups.value.find((x) => x.id === id);
		if (g) g.notes = notes;
	}

	return { activeTab, filters, sortBy, groups, sortedGroups, loading, refresh, setStatus, setNotes };
}

export function useScrape() {
	const progressData = useState<ScrapeProgressData | null>(
		"scrapeProgress",
		() => null,
	);
	const allSources = useState<SourceInfo[]>("scrapeSources", () => []);
	const scrapeMessage = useState<string>("scrapeMessage", () => "");
	// Tracks which finished run (by startedAt) the user has dismissed the panel
	// for. In-memory only — a reload will show the last run again, which is
	// usually helpful ("here's what happened while the tab was closed").
	const dismissedRunId = useState<string | null>(
		"scrapeDismissedRun",
		() => null,
	);

	const running = computed(() => progressData.value?.running ?? false);

	const panelVisible = computed(() => {
		const p = progressData.value;
		if (!p) return false;
		if (p.running) return true;
		return dismissedRunId.value !== p.startedAt;
	});

	async function refreshStatus() {
		try {
			const data = await $fetch<ScrapeProgressData>("/api/scrape/status");
			if (data.running || (data.completed?.length ?? 0) > 0 || data.startedAt) {
				progressData.value = data;
			} else if (progressData.value && !progressData.value.running) {
				// Server dropped the last-run snapshot — clear any stale local copy.
				progressData.value = null;
			}
		} catch {
			// swallow — polling errors shouldn't disrupt the UI
		}
	}

	async function ensureSources() {
		if (allSources.value.length) return;
		try {
			allSources.value = await $fetch<SourceInfo[]>("/api/sources");
		} catch {
			// continue without source info
		}
	}

	function dismiss() {
		if (progressData.value?.startedAt) {
			dismissedRunId.value = progressData.value.startedAt;
		}
	}

	async function trigger(sources?: string[]) {
		scrapeMessage.value = "";
		await ensureSources();
		// Optimistic panel — visible before the POST resolves.
		if (!progressData.value?.running) {
			progressData.value = {
				running: true,
				startedAt: new Date().toISOString(),
				finishedAt: null,
				total: sources?.length || allSources.value.length,
				completed: [],
			};
		}
		try {
			const r = await $fetch<{
				status: string;
				result?: { perSource: CompletedSource[] };
			}>("/api/scrape", { method: "POST", body: { sources } });

			// Always resync with server truth after the POST resolves.
			await refreshStatus();

			if (r.status === "ok" && r.result) {
				const fresh = r.result.perSource.reduce(
					(a, s) => a + s.newListings,
					0,
				);
				const errSources = r.result.perSource
					.filter((s) => s.errors.length > 0)
					.map((s) => s.source);
				scrapeMessage.value = `Gotowe. Nowych ofert: ${fresh}${
					errSources.length ? ` · błędy: ${errSources.join(", ")}` : ""
				}`;
				return { ...r, freshCount: fresh };
			}
			return r;
		} catch (e) {
			scrapeMessage.value = `Błąd: ${(e as Error).message}`;
			throw e;
		}
	}

	return {
		running,
		progressData,
		panelVisible,
		allSources,
		scrapeMessage,
		trigger,
		dismiss,
		refreshStatus,
		ensureSources,
	};
}

export function useNewCount() {
	const newCount = useState<number>("newCount", () => 0);

	async function peek(): Promise<number> {
		const r = await $fetch<{ count: number }>("/api/new-since-visit", {
			query: { peek: "1" },
		});
		newCount.value = r.count;
		return r.count;
	}

	async function markVisited(): Promise<number> {
		const r = await $fetch<{ count: number }>("/api/new-since-visit");
		newCount.value = 0;
		return r.count;
	}

	return { newCount, peek, markVisited };
}
