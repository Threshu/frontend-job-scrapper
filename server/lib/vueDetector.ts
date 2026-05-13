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
