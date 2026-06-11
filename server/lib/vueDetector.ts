// Word-boundary regex for framework names. Case-insensitive.
// "vue" matches "Vue", "Vue.js", "vuejs", "Vue 3", "Vue2", but NOT "vuejs.org" inside a longer slug.
const VUE_RE     = /\bvue(\.?js|2|3)?\b/i
const REACT_RE   = /\breact(\.?js)?\b/i
const ANGULAR_RE = /\bangular(\.?js)?\b/i
const SVELTE_RE  = /\bsvelte(kit|\.?js)?\b/i

export interface FrameworkFlags {
  hasVue: boolean
  hasReact: boolean
  hasAngular: boolean
  hasSvelte: boolean
  vueInTitle: boolean
}

export function detectFrameworks(input: {
  title: string
  description: string
  skills: string[]
}): FrameworkFlags {
  const haystack = [input.title, input.description, ...input.skills].join('\n')
  return {
    hasVue:     VUE_RE.test(haystack),
    hasReact:   REACT_RE.test(haystack),
    hasAngular: ANGULAR_RE.test(haystack),
    hasSvelte:  SVELTE_RE.test(haystack),
    vueInTitle: VUE_RE.test(input.title),
  }
}

// How prominent Vue is in a posting:
//  - primary  : Vue is in the title — the role IS a Vue role
//  - required : Vue appears in the main/required stack section, or in the skills array
//  - mention  : Vue only appears under "mile widziane" / "nice to have" / "plus"
//  - none     : not mentioned at all
//
// Drives the default UI filter — "primary + required" hide noise like
// "Senior Python Developer (Vue jako plus)".
export type VueRelevance = 'primary' | 'required' | 'mention' | 'none'

// Globaled so .matchAll() works; we read the last occurrence before Vue's position.
const NICE_TO_HAVE_RE = /mile widzian[ea]|nice[- ]to[- ]have|nice to have|\bplus\b|\bbonus\b|opcjonalnie|dodatkowym atutem|dodatkowo|preferred|will be a plus|advantageous|atut[ae]m b[ęe]dzie|by[ćc] plus|considered a plus|asset\b/gi
const REQUIRED_RE = /wymagania|wymagane|wymagamy|must[- ]have|must have|requirements|required|oczekujemy|oczekiwania|main (tech|stack)|core (skills|stack)|kluczowe|niezb[ęe]dne|musisz|expected|key skills|primary stack|tech stack|stack technologiczny|twoje zadania|zakres obowi[ąa]zk[óo]w|responsibilities|your role/gi

function lastMatchIndex(text: string, re: RegExp): number {
  let last = -1
  for (const m of text.matchAll(re)) {
    if (typeof m.index === 'number' && m.index > last) last = m.index
  }
  return last
}

export function vueInTitle(title: string): boolean {
  return VUE_RE.test(title)
}

export function classifyVueRelevance(
  title: string,
  description: string,
  skills: string[],
): VueRelevance {
  if (VUE_RE.test(title)) return 'primary'

  const skillsHasVue = skills.some((s) => VUE_RE.test(s))
  const descHasVue = VUE_RE.test(description)

  if (!skillsHasVue && !descHasVue) return 'none'

  if (descHasVue) {
    const m = description.match(VUE_RE)
    const idx = m && typeof m.index === 'number' ? m.index : description.toLowerCase().indexOf('vue')
    // Look at the section header that immediately precedes the Vue mention.
    // 1000 chars back is enough for most postings; bigger window risks pulling
    // in unrelated headers from far up the page.
    const ctxStart = Math.max(0, idx - 1000)
    const ctx = description.slice(ctxStart, idx + 50)
    const lastNice = lastMatchIndex(ctx, NICE_TO_HAVE_RE)
    const lastReq = lastMatchIndex(ctx, REQUIRED_RE)
    // "nice to have" header closer to Vue than any "required" header → optional.
    if (lastNice > lastReq && lastNice >= 0) return 'mention'
    return 'required'
  }

  // Skills array on most portals is a curated tech-stack list. Vue appearing
  // there without showing up in the (often shorter) description still means
  // it's part of the role's stack.
  return 'required'
}
