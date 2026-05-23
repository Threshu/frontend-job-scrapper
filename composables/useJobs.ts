import type { GroupDto } from "~~/server/api/groups/index.get";

export interface JobFilters {
	status: string;
	hasVue: boolean;
	source: string;
	search: string;
	includeStale: boolean;
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
	}));
	const groups = useState<GroupDto[]>("groups", () => []);
	const loading = useState<boolean>("groupsLoading", () => false);

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

	return { activeTab, filters, groups, loading, refresh, setStatus, setNotes };
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
