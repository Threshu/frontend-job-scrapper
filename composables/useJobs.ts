import type { GroupDto } from "~~/server/api/groups/index.get";

export interface JobFilters {
	status: string;
	hasVue: boolean;
	source: string;
	search: string;
	includeStale: boolean;
	hideNoise: boolean;
	vueInTitle: boolean;
}

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
	const running = useState<boolean>("scrapeRunning", () => false);
	const lastResult = useState<unknown>("scrapeLastResult", () => null);

	async function trigger(sources?: string[]) {
		running.value = true;
		try {
			const r = await $fetch("/api/scrape", {
				method: "POST",
				body: { sources },
			});
			lastResult.value = r;
			return r;
		} finally {
			running.value = false;
		}
	}

	return { running, lastResult, trigger };
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
