<script setup lang="ts">
	const { activeTab, sortedGroups, loading, refresh } = useJobs();
	const { running, trigger } = useScrape();
	const { newCount, peek, markVisited } = useNewCount();
	const { notifySupport, requestPermission, notify, permission } =
		useNotifications();

	const scrapeMessage = ref<string>("");

	interface SourceInfo {
		source: string;
		displayName: string;
		needsBrowser: boolean;
	}

	interface CompletedSource {
		source: string;
		fetched: number;
		newListings: number;
		newGroups: number;
		errors: string[];
	}

	interface ScrapeProgressData {
		running: boolean;
		startedAt: string | null;
		total: number;
		completed: CompletedSource[];
	}

	const progressData = ref<ScrapeProgressData | null>(null);
	const allSources = ref<SourceInfo[]>([]);
	const elapsedSeconds = ref(0);

	let progressTimer: ReturnType<typeof setInterval> | null = null;
	let elapsedTimer: ReturnType<typeof setInterval> | null = null;

	const sourceMap = computed(
		() => new Map(allSources.value.map((s) => [s.source, s])),
	);

	const MAX_ERRORS_SHOWN = 3

	const completedWithInfo = computed(() =>
		(progressData.value?.completed ?? []).map((c) => {
			// 403/apollo-state are partial failures — jobs were still saved via fallback.
			// Only treat as ⚠ when the scraper collected nothing at all.
			const criticalErrors = c.errors.filter(
				(e) => !e.includes('HTTP 403') && !e.includes('not in apollo state'),
			)
			const hasWarning = c.errors.length > 0 && (criticalErrors.length > 0 || c.fetched === 0)
			return {
				...c,
				displayName: sourceMap.value.get(c.source)?.displayName ?? c.source,
				shownErrors: c.errors.slice(0, MAX_ERRORS_SHOWN),
				hiddenErrorCount: Math.max(0, c.errors.length - MAX_ERRORS_SHOWN),
				hasWarning,
			}
		}),
	);

	const pendingSources = computed(() => {
		if (!progressData.value) return [];
		const done = new Set(progressData.value.completed.map((c) => c.source));
		return allSources.value.filter((s) => !done.has(s.source));
	});

	const progressPct = computed(() => {
		const d = progressData.value;
		if (!d || !d.total) return 0;
		return Math.round((d.completed.length / d.total) * 100);
	});

	function fmtElapsed(s: number): string {
		const m = Math.floor(s / 60);
		const sec = s % 60;
		return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${s}s`;
	}

	function stopProgress() {
		if (progressTimer) {
			clearInterval(progressTimer);
			progressTimer = null;
		}
		if (elapsedTimer) {
			clearInterval(elapsedTimer);
			elapsedTimer = null;
		}
	}

	async function pollProgress() {
		try {
			const data = await $fetch<ScrapeProgressData>("/api/scrape/status");
			if (progressData.value) progressData.value = data;
		} catch {
			// ignore poll errors
		}
	}

	await refresh();
	await peek();

	let pollTimer: ReturnType<typeof setInterval> | null = null;

	onMounted(() => {
		setTimeout(() => markVisited(), 4000);
		pollTimer = setInterval(async () => {
			const before = newCount.value;
			const fresh = await peek();
			if (fresh > before) {
				notify(`${fresh - before} nowa oferta`, { body: "Sprawdź listę" });
			}
		}, 60_000);
	});

	onBeforeUnmount(() => {
		if (pollTimer) clearInterval(pollTimer);
		stopProgress();
	});

	async function switchTab(tab: "active" | "applied" | "rejected") {
		activeTab.value = tab;
		await refresh();
	}

	async function doScrape() {
		scrapeMessage.value = "";
		elapsedSeconds.value = 0;

		if (!allSources.value.length) {
			try {
				allSources.value = await $fetch<SourceInfo[]>("/api/sources");
			} catch {
				// continue without source info
			}
		}

		progressData.value = {
			running: true,
			startedAt: new Date().toISOString(),
			total: allSources.value.length,
			completed: [],
		};

		elapsedTimer = setInterval(() => {
			elapsedSeconds.value++;
		}, 1000);
		progressTimer = setInterval(pollProgress, 2000);

		try {
			const r = (await trigger()) as {
				status: string;
				result?: {
					perSource: Array<{
						source: string;
						newListings: number;
						newGroups: number;
						errors: string[];
					}>;
				};
			};
			stopProgress();

			if (r.status === "already-running") {
				progressData.value = null;
				scrapeMessage.value = "Scrape już w toku — odśwież za chwilę.";
			} else if (r.result) {
				await pollProgress();
				const fresh = r.result.perSource.reduce(
					(a, s) => a + s.newListings,
					0,
				);
				const errSources = r.result.perSource
					.filter((s) => s.errors.length > 0)
					.map((s) => s.source);
				scrapeMessage.value = `Gotowe. Nowych ofert: ${fresh}${errSources.length ? ` · błędy: ${errSources.join(", ")}` : ""}`;
				await refresh();
				if (fresh > 0) {
					notify(`${fresh} nowa oferta`, { body: "Sprawdź listę" });
				}
				setTimeout(() => {
					progressData.value = null;
				}, 8000);
			}
		} catch (e) {
			stopProgress();
			progressData.value = null;
			scrapeMessage.value = `Błąd: ${(e as Error).message}`;
		}
	}
</script>

<template>
	<main class="container">
		<header class="top">
			<div>
				<h1>Vue Job Hunter</h1>
				<p class="subtitle">
					Oferty pracy dla Vue developera z polskich portali IT
				</p>
			</div>
			<div class="actions">
				<span v-if="newCount > 0" class="new-badge"
					>+{{ newCount }} nowych</span
				>
				<ClientOnly>
					<button
						v-if="notifySupport && permission === 'default'"
						class="btn-ghost"
						@click="requestPermission"
					>
						🔔 Włącz powiadomienia
					</button>
				</ClientOnly>
				<button class="btn-scrape" :disabled="running" @click="doScrape">
					{{ running ? "⟳ Scrapuję..." : "⟳ Scrapuj teraz" }}
				</button>
			</div>
		</header>

		<div class="left-panels">
		<div v-if="progressData" class="scrape-progress">
			<div class="sp-head">
				<span class="sp-title">{{
					running ? "Scrapowanie w toku..." : "Scrapowanie zakończone"
				}}</span>
				<span class="sp-elapsed">{{ fmtElapsed(elapsedSeconds) }}</span>
				<span class="sp-count"
					>{{ progressData.completed.length }} /
					{{ progressData.total }} źródeł</span
				>
			</div>
			<div class="sp-bar-track">
				<div class="sp-bar-fill" :style="{ width: `${progressPct}%` }" />
			</div>
			<div class="sp-sources">
				<div
					v-for="c in completedWithInfo"
					:key="c.source"
					class="sp-source-block"
				>
					<div class="sp-row" :class="{ 'sp-row-err': c.hasWarning }">
						<span class="sp-icon">{{ c.hasWarning ? "⚠" : "✓" }}</span>
						<span class="sp-name">{{ c.displayName }}</span>
						<span class="sp-stat"
							>{{ c.fetched }} pobranych · {{ c.newGroups }} na liście</span
						>
					</div>
					<div v-if="c.shownErrors.length" class="sp-errs">
						<p
							v-for="(e, i) in c.shownErrors"
							:key="i"
							class="sp-err-line"
						>{{ e }}</p>
						<p v-if="c.hiddenErrorCount > 0" class="sp-err-more">
							… i {{ c.hiddenErrorCount }} więcej
						</p>
					</div>
				</div>
				<div
					v-for="s in pendingSources"
					:key="s.source"
					class="sp-row sp-pending"
				>
					<span class="sp-icon sp-spin">⟳</span>
					<span class="sp-name">{{ s.displayName }}</span>
					<span v-if="s.needsBrowser" class="sp-browser">przeglądarka</span>
				</div>
			</div>
		</div>

		<SalaryCalculator />
		</div>

		<p v-if="scrapeMessage" class="scrape-msg">{{ scrapeMessage }}</p>

		<nav class="tabs">
			<button
				class="tab"
				:class="{ active: activeTab === 'active' }"
				@click="switchTab('active')"
			>
				Oferty
			</button>
			<button
				class="tab"
				:class="{ active: activeTab === 'applied' }"
				@click="switchTab('applied')"
			>
				Zaaplikowane
			</button>
			<button
				class="tab"
				:class="{ active: activeTab === 'rejected' }"
				@click="switchTab('rejected')"
			>
				Odrzucone
			</button>
		</nav>

		<JobFilters v-if="activeTab === 'active'" />

		<section class="results">
			<p v-if="loading" class="status">Ładuję...</p>
			<template v-else-if="!sortedGroups.length">
				<p v-if="activeTab === 'active'" class="status">
					Brak ofert. Kliknij &quot;Scrapuj teraz&quot; żeby pobrać dane z
					portali.
				</p>
				<p v-else-if="activeTab === 'applied'" class="status">
					Brak zaaplikowanych ofert.
				</p>
				<p v-else-if="activeTab === 'rejected'" class="status">
					Brak odrzuconych ofert.
				</p>
			</template>
			<JobCard v-for="g in sortedGroups" :key="g.id" :group="g" />
		</section>
	</main>
</template>

<style scoped>
	.container {
		max-width: 960px;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
	}
	.top {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}
	.top h1 {
		margin: 0;
		font-size: 1.6rem;
	}
	.subtitle {
		margin: 0.3rem 0 0;
		color: var(--muted);
		font-size: 0.95rem;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
	}
	.btn-scrape {
		padding: 0.6rem 1.2rem;
		background: var(--accent);
		color: white;
		border: 0;
		border-radius: 0.4rem;
		cursor: pointer;
		font-weight: 600;
		font-size: 0.95rem;
	}
	.btn-scrape:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.btn-scrape:hover:not(:disabled) {
		filter: brightness(1.1);
	}
	.btn-ghost {
		padding: 0.5rem 0.9rem;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 0.4rem;
		color: var(--fg);
		cursor: pointer;
		font-size: 0.85rem;
	}
	.btn-ghost:hover {
		border-color: var(--accent);
	}
	.new-badge {
		padding: 0.4rem 0.8rem;
		background: var(--accent-2);
		color: #052e16;
		font-weight: 700;
		border-radius: 0.4rem;
		font-size: 0.85rem;
		align-self: center;
	}

	/* ── Left fixed panels (scrape progress + salary calculator) ── */
	.left-panels {
		position: fixed;
		left: 1rem;
		top: 1.5rem;
		width: 320px;
		z-index: 100;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-height: calc(100vh - 3rem);
		overflow-y: auto;
	}

	.scrape-progress {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		padding: 0.9rem 1rem;
		flex-shrink: 0;
	}
	.sp-head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: 0.6rem;
	}
	.sp-title {
		font-size: 0.9rem;
		font-weight: 600;
		flex: 1;
	}
	.sp-elapsed {
		font-size: 0.8rem;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.sp-count {
		font-size: 0.8rem;
		color: var(--muted);
	}
	.sp-bar-track {
		height: 4px;
		background: var(--border);
		border-radius: 2px;
		overflow: hidden;
		margin-bottom: 0.75rem;
	}
	.sp-bar-fill {
		height: 100%;
		background: var(--accent);
		border-radius: 2px;
		transition: width 0.4s ease;
	}
	.sp-sources {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.sp-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.82rem;
	}
	.sp-icon {
		width: 1rem;
		text-align: center;
		flex-shrink: 0;
	}
	.sp-name {
		font-weight: 500;
		min-width: 6rem;
	}
	.sp-stat {
		color: var(--muted);
	}
	.sp-browser {
		font-size: 0.72rem;
		color: var(--muted);
		opacity: 0.7;
	}
	.sp-done .sp-icon {
		color: var(--accent-2);
	}
	.sp-row-err .sp-icon {
		color: #f87171;
	}
	.sp-source-block {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.sp-errs {
		padding-left: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.sp-err-line {
		font-size: 0.72rem;
		color: #f87171;
		margin: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sp-err-more {
		font-size: 0.72rem;
		color: var(--muted);
		margin: 0;
		opacity: 0.7;
	}
	.sp-pending {
		opacity: 0.5;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.sp-spin {
		display: inline-block;
		animation: spin 1s linear infinite;
	}

	.scrape-msg {
		padding: 0.6rem 1rem;
		background: var(--card);
		border-left: 3px solid var(--accent);
		border-radius: 0.3rem;
		margin: 0 0 1rem;
		font-size: 0.9rem;
	}
	.results {
		margin-top: 1.2rem;
	}
	.status {
		color: var(--muted);
		text-align: center;
		padding: 2rem 0;
	}

	.tabs {
		display: flex;
		gap: 0.25rem;
		margin-bottom: 1rem;
		border-bottom: 1px solid var(--border);
		padding-bottom: 0;
	}
	.tab {
		padding: 0.55rem 1.2rem;
		background: transparent;
		border: 1px solid transparent;
		border-bottom: none;
		border-radius: 0.4rem 0.4rem 0 0;
		cursor: pointer;
		font-size: 0.9rem;
		color: var(--muted);
		position: relative;
		bottom: -1px;
	}
	.tab:hover {
		color: var(--fg);
	}
	.tab.active {
		background: var(--card);
		border-color: var(--border);
		border-bottom-color: var(--card);
		color: var(--fg);
		font-weight: 600;
	}
</style>
