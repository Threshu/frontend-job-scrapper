<script setup lang="ts">
	const { activeTab, sortedGroups, loading, refresh } = useJobs();
	const {
		running,
		progressData,
		panelVisible,
		allSources,
		scrapeMessage,
		trigger,
		dismiss,
		refreshStatus,
		ensureSources,
	} = useScrape();
	const { newCount, peek, markVisited } = useNewCount();
	const { notifySupport, requestPermission, notify, permission } =
		useNotifications();

	const sourceMap = computed(
		() => new Map(allSources.value.map((s) => [s.source, s])),
	);

	const MAX_ERRORS_SHOWN = 3;

	// Reactive "now" tick so elapsed time updates smoothly even after the run
	// finishes (freezes at finishedAt-startedAt via the computed below).
	// useState so SSR and hydration see the same initial value — a plain
	// ref(Date.now()) drifts by however long hydration took and mismatches.
	const nowMs = useState<number>("scrapeNowMs", () => Date.now());

	const elapsedSeconds = computed(() => {
		const p = progressData.value;
		if (!p?.startedAt) return 0;
		const start = new Date(p.startedAt).getTime();
		const end = p.running
			? nowMs.value
			: p.finishedAt
				? new Date(p.finishedAt).getTime()
				: nowMs.value;
		return Math.max(0, Math.floor((end - start) / 1000));
	});

	const completedWithInfo = computed(() =>
		(progressData.value?.completed ?? []).map((c) => {
			// 403/apollo-state are partial failures — jobs were still saved via fallback.
			// Only treat as ⚠ when the scraper collected nothing at all.
			const criticalErrors = c.errors.filter(
				(e) => !e.includes("HTTP 403") && !e.includes("not in apollo state"),
			);
			const hasWarning =
				c.errors.length > 0 && (criticalErrors.length > 0 || c.fetched === 0);
			return {
				...c,
				displayName: sourceMap.value.get(c.source)?.displayName ?? c.source,
				shownErrors: c.errors.slice(0, MAX_ERRORS_SHOWN),
				hiddenErrorCount: Math.max(0, c.errors.length - MAX_ERRORS_SHOWN),
				hasWarning,
			};
		}),
	);

	const pendingSources = computed(() => {
		if (!progressData.value?.running) return [];
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

	function fmtDuration(ms: number): string {
		if (!ms) return "";
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		const rem = s % 60;
		return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
	}

	// Initial load runs on SSR only — the resulting useState values ship down
	// in Nuxt's payload and are already populated when the client hydrates.
	// Running these on the client too would double every request.
	if (import.meta.server) {
		await Promise.all([refresh(), peek(), refreshStatus(), ensureSources()]);
	}

	let newCountTimer: ReturnType<typeof setInterval> | null = null;
	let scrapePollHandle: ReturnType<typeof setTimeout> | null = null;
	let nowTimer: ReturnType<typeof setInterval> | null = null;

	// Adaptive scrape-status polling: 2s while running (need snappy live
	// updates), 10s when idle (only cares about detecting new runs from other
	// tabs / cron). Uses recursive setTimeout so the delay can change per tick.
	const SCRAPE_POLL_ACTIVE_MS = 2_000;
	const SCRAPE_POLL_IDLE_MS = 10_000;
	async function scheduleScrapePoll() {
		await refreshStatus();
		const delay = running.value ? SCRAPE_POLL_ACTIVE_MS : SCRAPE_POLL_IDLE_MS;
		scrapePollHandle = setTimeout(scheduleScrapePoll, delay);
	}

	// Auto-refresh the visible list whenever another source finishes, so new
	// offers appear without waiting for the full run to end.
	let lastCompletedCount = progressData.value?.completed.length ?? 0;
	watch(
		() => progressData.value?.completed.length ?? 0,
		async (n) => {
			if (n > lastCompletedCount && progressData.value?.running) {
				await refresh();
			}
			lastCompletedCount = n;
		},
	);

	// Notify when a foreign-tab-triggered run finishes with new offers.
	watch(
		() => progressData.value?.running,
		async (isRunning, wasRunning) => {
			if (wasRunning && !isRunning) {
				const before = newCount.value;
				const fresh = await peek();
				await refresh();
				if (fresh > before) {
					notify(`${fresh - before} nowa oferta`, { body: "Sprawdź listę" });
				}
			}
		},
	);

	onMounted(() => {
		setTimeout(() => markVisited(), 4000);
		newCountTimer = setInterval(async () => {
			const before = newCount.value;
			const fresh = await peek();
			if (fresh > before) {
				notify(`${fresh - before} nowa oferta`, { body: "Sprawdź listę" });
			}
		}, 60_000);
		scheduleScrapePoll();
		nowTimer = setInterval(() => {
			nowMs.value = Date.now();
		}, 1_000);
	});

	// If a run starts (via trigger() or a foreign-tab poll landing on running=true),
	// pull the next status check forward so the panel updates within 2s rather
	// than waiting up to the full idle interval.
	watch(running, (isRunning) => {
		if (isRunning && scrapePollHandle) {
			clearTimeout(scrapePollHandle);
			scheduleScrapePoll();
		}
	});

	onBeforeUnmount(() => {
		if (newCountTimer) clearInterval(newCountTimer);
		if (scrapePollHandle) clearTimeout(scrapePollHandle);
		if (nowTimer) clearInterval(nowTimer);
	});

	async function switchTab(tab: "active" | "applied" | "rejected") {
		activeTab.value = tab;
		await refresh();
	}

	async function doScrape() {
		try {
			const r = (await trigger()) as { freshCount?: number };
			await refresh();
			if (r?.freshCount && r.freshCount > 0) {
				notify(`${r.freshCount} nowa oferta`, { body: "Sprawdź listę" });
			}
		} catch {
			// scrapeMessage set by trigger()
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
				<div class="actions-left">
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
				</div>
				<button class="btn-scrape" :disabled="running" @click="doScrape">
					{{ running ? "⟳ Scrapuję..." : "⟳ Scrapuj teraz" }}
				</button>
			</div>
		</header>

		<div class="left-panels">
		<div v-if="panelVisible && progressData" class="scrape-progress">
			<div class="sp-head">
				<span class="sp-title">{{
					running ? "Scrapowanie w toku..." : "Scrapowanie zakończone"
				}}</span>
				<span class="sp-elapsed">{{ fmtElapsed(elapsedSeconds) }}</span>
				<span class="sp-count"
					>{{ progressData.completed.length }} /
					{{ progressData.total }} źródeł</span
				>
				<button
					v-if="!running"
					class="sp-close"
					@click="dismiss"
					title="Zamknij"
				>×</button>
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
						<span v-if="c.durationMs" class="sp-dur">{{ fmtDuration(c.durationMs) }}</span>
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
		align-items: center;
	}
	/* Reserve a stable slot for the badge + notifications button so the
	   scrape button doesn't shift when they hydrate/appear/disappear. */
	.actions-left {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		justify-content: flex-end;
		/* Fits "🔔 Włącz powiadomienia" (~175px) + gap + "+N nowych" badge. */
		min-width: 290px;
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
		flex-shrink: 0;
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
	.sp-close {
		margin-left: auto;
		background: none;
		border: none;
		color: var(--muted);
		font-size: 1.1rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 0.1rem;
		opacity: 0.6;
		flex-shrink: 0;
		&:hover {
			opacity: 1;
			color: var(--fg);
		}
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
		flex: 1;
	}
	.sp-dur {
		font-size: 0.72rem;
		color: var(--muted);
		opacity: 0.6;
		margin-left: auto;
		flex-shrink: 0;
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
