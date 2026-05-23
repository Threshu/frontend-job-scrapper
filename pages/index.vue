<script setup lang="ts">
	const { activeTab, groups, loading, refresh } = useJobs();
	const { running, trigger } = useScrape();
	const { newCount, peek, markVisited } = useNewCount();
	const { notifySupport, requestPermission, notify, permission } =
		useNotifications();

	const scrapeMessage = ref<string>("");

	await refresh();
	await peek();

	let pollTimer: ReturnType<typeof setInterval> | null = null;

	onMounted(() => {
		// Mark as visited shortly after the user has had a chance to see the badge.
		setTimeout(() => {
			markVisited();
		}, 4000);

		// Poll periodically so the user is notified when the cron picks up new
		// offers in the background.
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
	});

	async function switchTab(tab: "active" | "applied" | "rejected") {
		activeTab.value = tab;
		await refresh();
	}

	async function doScrape() {
		scrapeMessage.value = "Scrapuję...";
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
			if (r.status === "already-running") {
				scrapeMessage.value = "Scrape już w toku — odśwież za chwilę.";
			} else if (r.result) {
				const fresh = r.result.perSource.reduce((a, s) => a + s.newListings, 0);
				const errSources = r.result.perSource
					.filter((s) => s.errors.length > 0)
					.map((s) => s.source);
				scrapeMessage.value = `Gotowe. Nowych ofert: ${fresh}${errSources.length ? ` · błędy: ${errSources.join(", ")}` : ""}`;
				await refresh();
				if (fresh > 0) {
					notify(`${fresh} nowa oferta`, { body: "Sprawdź listę" });
				}
			}
		} catch (e) {
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
			<template v-else-if="!groups.length">
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
			<JobCard v-for="g in groups" :key="g.id" :group="g" />
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
