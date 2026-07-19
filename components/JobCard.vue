<script setup lang="ts">
import type { GroupDto } from '~~/server/api/groups/index.get'
import { STATUS_LABEL, type Status } from '~/composables/useJobs'

const props = defineProps<{ group: GroupDto }>()
const { setStatus } = useJobs()

const SOURCE_LABEL: Record<string, string> = {
  justjoin: 'JJIT',
  nofluffjobs: 'NFJ',
  theprotocol: 'tP',
  bulldogjob: 'BD',
  rocketjobs: 'RJ',
  pracuj: 'Pracuj',
  linkedin: 'LI',
  indeed: 'Indeed',
  remotive: 'Remotive',
}

function fmtSalary(g: GroupDto) {
  const s = g.bestSalary
  if (!s) return null
  const cur = s.currency ?? ''
  if (s.min && s.max) return `${s.min.toLocaleString('pl-PL')}–${s.max.toLocaleString('pl-PL')} ${cur}`
  if (s.max) return `do ${s.max.toLocaleString('pl-PL')} ${cur}`
  if (s.min) return `od ${s.min.toLocaleString('pl-PL')} ${cur}`
  return null
}

function highlightVueReact(skill: string): 'vue' | 'react' | 'angular' | 'svelte' | null {
  const s = skill.toLowerCase()
  if (/\bvue/.test(s)) return 'vue'
  if (/\breact/.test(s)) return 'react'
  if (/\bangular/.test(s)) return 'angular'
  if (/\bsvelte/.test(s)) return 'svelte'
  return null
}

const primaryListing = computed(() => props.group.listings[0])

// One pill per source — NFJ (and others) can post the same job in N regions,
// each with a unique sourceId. Pick the listing with the earliest firstSeenAt
// so the link points to the "original" entry.
const uniqueSourceListings = computed(() => {
  const best = new Map<string, typeof props.group.listings[number]>()
  for (const l of props.group.listings) {
    const existing = best.get(l.source)
    if (!existing || l.firstSeenAt < existing.firstSeenAt) best.set(l.source, l)
  }
  return Array.from(best.values())
})

const staleTooltip = computed(() => {
  const reasons = props.group.listings.map((l) => l.staleReason).filter(Boolean) as string[]
  if (reasons.includes('unseen') && reasons.includes('aged')) return 'Zniknęło ze źródła i jest stare'
  if (reasons.includes('unseen')) return "Zniknęło ze źródła (niewidziane przy ostatnich scrape'ach)"
  if (reasons.includes('aged')) return 'Stara data publikacji'
  return 'Nieaktualne'
})
const allSkills = computed(() => {
  const set = new Map<string, string>()
  for (const l of props.group.listings) {
    for (const s of l.skills) {
      const key = s.toLowerCase()
      if (!set.has(key)) set.set(key, s)
    }
  }
  return Array.from(set.values())
})

const STATUS_COLOR: Record<string, string> = {
  new:        'badge-new',
  interested: 'badge-interested',
  applied:    'badge-applied',
  replied:    'badge-replied',
  rejected:   'badge-rejected',
  hidden:     'badge-hidden',
}

async function change(s: Status) {
  await setStatus(props.group.id, s)
}

// Swipe gesture handling
const cardInnerRef = ref<HTMLElement | null>(null)
const swipeX = ref(0)
const swipeStartX = ref(0)
const swipeStartY = ref(0)
const isPointerDown = ref(false)
const isHorizontalSwipe = ref(false)
const SWIPE_THRESHOLD = 90

function onTouchStart(e: TouchEvent) {
  swipeStartX.value = e.touches[0].clientX
  swipeStartY.value = e.touches[0].clientY
  isPointerDown.value = true
  isHorizontalSwipe.value = false
}

function onTouchMoveHandler(e: TouchEvent) {
  if (!isPointerDown.value) return
  const dx = e.touches[0].clientX - swipeStartX.value
  const dy = e.touches[0].clientY - swipeStartY.value

  if (!isHorizontalSwipe.value) {
    if (Math.abs(dy) > Math.abs(dx)) {
      isPointerDown.value = false
      return
    }
    if (Math.abs(dx) < 5) return
    isHorizontalSwipe.value = true
  }

  e.preventDefault()
  swipeX.value = dx
}

function onTouchEnd() {
  const x = swipeX.value
  isPointerDown.value = false
  isHorizontalSwipe.value = false
  swipeX.value = 0

  if (x >= SWIPE_THRESHOLD) {
    void change('applied')
  } else if (x <= -SWIPE_THRESHOLD) {
    void change('rejected')
  }
}

onMounted(() => {
  cardInnerRef.value?.addEventListener('touchmove', onTouchMoveHandler, { passive: false })
})

onUnmounted(() => {
  cardInnerRef.value?.removeEventListener('touchmove', onTouchMoveHandler)
})

const swipeStyle = computed(() => ({
  transform: `translateX(${swipeX.value}px)`,
  transition: isPointerDown.value ? 'none' : 'transform 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
}))

const swipePct = computed(() => Math.min(Math.abs(swipeX.value) / SWIPE_THRESHOLD, 1))
const swipeLocked = computed(() => Math.abs(swipeX.value) >= SWIPE_THRESHOLD)

const swipeBgAppliedStyle = computed(() => ({
  opacity: swipeX.value > 0 ? swipePct.value : 0,
  background: swipeLocked.value ? 'rgba(34, 197, 94, 0.55)' : 'rgba(34, 197, 94, 0.25)',
}))

const swipeBgRejectedStyle = computed(() => ({
  opacity: swipeX.value < 0 ? swipePct.value : 0,
  background: swipeLocked.value ? 'rgba(239, 68, 68, 0.55)' : 'rgba(239, 68, 68, 0.25)',
}))

const swipeIconScale = computed(() => 1 + swipePct.value * 0.4)
</script>

<template>
  <article class="card" :class="{ 'is-vue': group.hasVue, 'is-stale': group.isStale }">

    <!-- Swipe action backgrounds -->
    <div class="swipe-bg swipe-bg-applied" :style="swipeBgAppliedStyle">
      <span class="swipe-icon" :style="{ transform: `scale(${swipeIconScale})` }">✓</span>
      <span class="swipe-label">Zaaplikowane</span>
    </div>
    <div class="swipe-bg swipe-bg-rejected" :style="swipeBgRejectedStyle">
      <span class="swipe-label">Odrzucone</span>
      <span class="swipe-icon" :style="{ transform: `scale(${swipeIconScale})` }">✗</span>
    </div>

    <!-- Card content -->
    <div
      ref="cardInnerRef"
      class="card-inner"
      :style="swipeStyle"
      @touchstart.passive="onTouchStart"
      @touchend.passive="onTouchEnd"
      @touchcancel.passive="onTouchEnd"
    >
      <header class="head">
        <div class="title-block">
          <h2 class="title">{{ group.canonicalTitle }}</h2>
          <p class="company">{{ group.canonicalCompany }}</p>
        </div>
        <div class="meta">
          <span v-if="group.isStale" class="pill pill-stale" :title="staleTooltip">Archiwum</span>
          <span v-if="group.vueInTitle" class="pill pill-vue-strong">Vue w tytule</span>
          <span v-else-if="group.vueRelevance === 'required'" class="pill pill-vue">Vue w stacku</span>
          <span v-else-if="group.vueRelevance === 'mention'" class="pill pill-vue-weak" title="Vue tylko jako mile widziane">Vue jako plus</span>
          <span v-else-if="group.hasVue" class="pill pill-vue">Vue w opisie</span>
          <span v-if="group.hasReact" class="pill pill-react">React</span>
          <span v-if="group.hasAngular" class="pill pill-angular">Angular</span>
          <span class="status" :class="STATUS_COLOR[group.status]">{{ STATUS_LABEL[group.status as Status] ?? group.status }}</span>
        </div>
      </header>

      <div class="sub">
        <span v-if="primaryListing?.location">{{ primaryListing.location }}</span>
        <span v-if="primaryListing?.remote" class="muted">· remote</span>
        <span v-if="primaryListing?.experience" class="muted">· {{ primaryListing.experience }}</span>
        <span v-if="fmtSalary(group)" class="salary">· {{ fmtSalary(group) }}</span>
      </div>

      <div class="sources">
        <a
          v-for="l in uniqueSourceListings"
          :key="l.source"
          :href="l.url"
          target="_blank"
          rel="noopener"
          class="source-pill"
        >{{ SOURCE_LABEL[l.source] ?? l.source }} ↗</a>
      </div>

      <div v-if="allSkills.length" class="skills">
        <span
          v-for="s in allSkills"
          :key="s"
          class="skill"
          :class="highlightVueReact(s) ? `skill-${highlightVueReact(s)}` : ''"
        >{{ s }}</span>
      </div>

      <div class="card-actions">
        <button
          class="action-btn action-applied"
          :class="{ active: group.status === 'applied' }"
          @click="change('applied')"
        >✓ Zaaplikowano</button>
        <button
          class="action-btn action-rejected"
          :class="{ active: group.status === 'rejected' }"
          @click="change('rejected')"
        >✗ Odrzuć</button>
      </div>
    </div>

  </article>
</template>

<style scoped>
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  margin-bottom: 0.8rem;
  position: relative;
  overflow: hidden;
}
.card.is-vue { border-left: 3px solid var(--vue); }
.card.is-stale { opacity: 0.55; }
.card.is-stale:hover { opacity: 0.85; }

.swipe-bg {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  pointer-events: none;
  border-radius: inherit;
  transition: background 0.1s ease;
}
.swipe-bg-applied {
  padding-left: 1.5rem;
  justify-content: flex-start;
  color: #4ade80;
}
.swipe-bg-rejected {
  padding-right: 1.5rem;
  justify-content: flex-end;
  color: #fca5a5;
}
.swipe-icon {
  font-size: 1.5rem;
  font-weight: 700;
  line-height: 1;
  display: inline-block;
  transition: transform 0.1s ease;
}
.swipe-label {
  font-size: 0.9rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.card-inner {
  padding: 1rem 1.2rem;
  position: relative;
  z-index: 1;
  background: var(--card);
  will-change: transform;
}

.head {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-start;
}
.title-block { flex: 1; }
.title { margin: 0; font-size: 1.1rem; line-height: 1.3; }
.company { margin: 0.2rem 0 0; color: var(--muted); font-size: 0.9rem; }
.meta { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }

.sub {
  font-size: 0.85rem;
  color: var(--muted);
  margin-top: 0.5rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.salary { color: var(--accent-2); font-weight: 600; }
.muted { opacity: 0.7; }

.sources {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.6rem;
}
.source-pill {
  font-size: 0.85rem;
  font-weight: 600;
  padding: 0.45rem 0.9rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  color: var(--fg);
  text-decoration: none;
  flex: 1;
  text-align: center;
  min-height: 2.2rem;
  display: flex;
  align-items: center;
  justify-content: center;
}
.source-pill:hover { background: var(--accent); color: white; border-color: var(--accent); }

.skills {
  margin-top: 0.6rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.skill {
  font-size: 0.75rem;
  padding: 0.15rem 0.5rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 0.3rem;
}
.skill-vue     { background: rgba(65, 184, 131, 0.2); border-color: var(--vue); color: var(--vue); font-weight: 600; }
.skill-react   { background: rgba(97, 218, 251, 0.15); border-color: #61dafb; color: #61dafb; }
.skill-angular { background: rgba(221, 0, 49, 0.15); border-color: #dd0031; color: #ff5e7e; }
.skill-svelte  { background: rgba(255, 62, 0, 0.15); border-color: #ff3e00; color: #ff7a4d; }

.pill {
  font-size: 0.7rem;
  padding: 0.15rem 0.45rem;
  border-radius: 0.3rem;
  font-weight: 600;
}
.pill-vue        { background: rgba(65, 184, 131, 0.15); color: var(--vue); }
.pill-vue-strong { background: var(--vue); color: white; }
.pill-vue-weak   { background: rgba(148, 163, 184, 0.18); color: #94a3b8; font-style: italic; }
.pill-react      { background: rgba(97, 218, 251, 0.15); color: #61dafb; }
.pill-angular    { background: rgba(221, 0, 49, 0.15); color: #ff5e7e; }
.pill-stale      { background: rgba(148, 163, 184, 0.25); color: #cbd5e1; }

.status {
  font-size: 0.7rem;
  padding: 0.15rem 0.5rem;
  border-radius: 0.3rem;
  font-weight: 600;
}
.badge-new        { background: rgba(99, 102, 241, 0.2);  color: #a5b4fc; }
.badge-interested { background: rgba(245, 158, 11, 0.2);  color: #fbbf24; }
.badge-applied    { background: rgba(34, 197, 94, 0.2);   color: #4ade80; }
.badge-replied    { background: rgba(168, 85, 247, 0.2);  color: #c4b5fd; }
.badge-rejected   { background: rgba(239, 68, 68, 0.2);   color: #fca5a5; }
.badge-hidden     { background: rgba(100, 116, 139, 0.2); color: #94a3b8; }

.card-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.8rem;
  padding-top: 0.7rem;
  border-top: 1px solid var(--border);
}

.action-btn {
  flex: 1;
  padding: 0.4rem 0.6rem;
  font-size: 0.85rem;
  font-weight: 600;
  border-radius: 0.4rem;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.action-applied:hover,
.action-applied.active {
  background: rgba(34, 197, 94, 0.2);
  border-color: #4ade80;
  color: #4ade80;
}

.action-rejected:hover,
.action-rejected.active {
  background: rgba(239, 68, 68, 0.2);
  border-color: #fca5a5;
  color: #fca5a5;
}
</style>
