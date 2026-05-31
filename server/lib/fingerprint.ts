// Normalizes company and title strings into a fingerprint used for cross-source
// deduplication. Two listings with the same fingerprint are assumed to be the
// same logical job. The fuzzy step in dedup.ts widens this when exact match fails.

const COMPANY_SUFFIXES = [
  /\bsp\.?\s*z\s*o\.?\s*o\.?\b/gi,
  /\bz\s+ograniczon[ąa]\s+odpowiedzialnością/gi, // pełna forma polska LLC (\b po ą nie działa)
  /\bs\.?\s*a\.?\b/gi,
  /\bspółka\b/gi,
  /\bprosta\s+spółka\s+akcyjna\b/gi,
  /\bllc\b/gi,
  /\bltd\.?\b/gi,
  /\binc\.?\b/gi,
  /\bgmbh\b/gi,
  /\bsa\.?\b/gi,
  /\bbv\b/gi,
]

const TITLE_NOISE = [
  /\(remote\)/gi,
  /\(zdalna?\)/gi,
  /\[m\/f(\/d)?\]/gi,
  /\(m\/f(\/d)?\)/gi,
  /\(m\/k\)/gi,
  /\(h\/f\)/gi,     // francuski wskaźnik płci
  /\(f\/m(\/d)?\)/gi,
  /\bm\/k\b/gi,     // bez nawiasów: "Developer m/k"
  /\bh\/f\b/gi,     // bez nawiasów: "Architecte h/f"
  /\bm\/f\b/gi,
  /\bremote\b/gi,
  /\bzdalna?\b/gi,
  /\bhybryda\b/gi,
  /\bhybrid\b/gi,
  /\bonsite\b/gi,
]

function squashWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function normalizeCompany(raw: string): string {
  let s = raw.toLowerCase()
  for (const re of COMPANY_SUFFIXES) s = s.replace(re, ' ')
  s = s.replace(/[.,()/\\&]+/g, ' ')
  return squashWhitespace(s)
}

export function normalizeTitle(raw: string): string {
  let s = raw.toLowerCase()
  for (const re of TITLE_NOISE) s = s.replace(re, ' ')
  // strip leading/trailing seniority qualifiers
  s = s.replace(/\b(senior|mid|junior|regular|lead|principal|staff)\b/gi, ' ')
  s = s.replace(/[.,()/\\&]+/g, ' ')
  return squashWhitespace(s)
}

export function fingerprintFor(company: string, title: string): string {
  return `${normalizeCompany(company)}|${normalizeTitle(title)}`
}

// Levenshtein distance — small implementation, used only on short title strings.
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = new Array(b.length + 1)
  let curr = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      )
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}
