<script setup lang="ts">
import { STATUSES, STATUS_LABEL, SORT_OPTIONS, VUE_RELEVANCE_OPTIONS, type Status } from '~/composables/useJobs'

interface SourceMeta { source: string; displayName: string }

const { filters, sortBy, refresh } = useJobs()
const { data: sources } = await useFetch<SourceMeta[]>('/api/sources')

function apply() { refresh() }
</script>

<template>
  <div class="filters">
    <label class="field">
      <span>Status</span>
      <select v-model="filters.status" @change="apply">
        <option value="">wszystkie</option>
        <option v-for="s in STATUSES" :key="s" :value="s">{{ STATUS_LABEL[s as Status] }}</option>
      </select>
    </label>

    <label class="field">
      <span>Źródło</span>
      <select v-model="filters.source" @change="apply">
        <option value="">wszystkie</option>
        <option v-for="s in sources ?? []" :key="s.source" :value="s.source">{{ s.displayName }}</option>
      </select>
    </label>

    <label class="checkbox">
      <input v-model="filters.hasVue" type="checkbox" @change="apply">
      <span>Tylko z Vue</span>
    </label>

    <label class="field">
      <span>Vue w roli</span>
      <select v-model="filters.vueRelevance" @change="apply">
        <option v-for="o in VUE_RELEVANCE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </label>

    <label class="checkbox">
      <input v-model="filters.hideNoise" type="checkbox" @change="apply">
      <span>Ukryj szum</span>
    </label>

    <label class="checkbox">
      <input v-model="filters.vueInTitle" type="checkbox" @change="apply">
      <span>Vue w tytule</span>
    </label>

    <label class="checkbox">
      <input v-model="filters.includeStale" type="checkbox" @change="apply">
      <span>Pokaż archiwum</span>
    </label>

    <label class="field grow">
      <span>Szukaj</span>
      <input v-model="filters.search" type="text" placeholder="firma, tytuł..." @keyup.enter="apply">
    </label>

    <label class="field">
      <span>Sortowanie</span>
      <select v-model="sortBy">
        <option v-for="o in SORT_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </label>

    <button class="btn" @click="apply">Filtruj</button>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: end;
  padding: 1rem;
  background: var(--card);
  border-radius: 0.5rem;
  border: 1px solid var(--border);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
}
.field.grow { flex: 1; min-width: 200px; }
.field span { color: var(--muted); }
.field select, .field input {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg);
  color: var(--fg);
  font-size: 0.95rem;
}
.checkbox {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.9rem;
  padding-bottom: 0.4rem;
}
.btn {
  padding: 0.45rem 1rem;
  background: var(--accent);
  color: white;
  border: 0;
  border-radius: 0.3rem;
  cursor: pointer;
  font-weight: 500;
}
.btn:hover { filter: brightness(1.1); }
</style>
