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
  // Strip pipe too — it's the fingerprint separator, so a company name
  // containing "|" (e.g. "Careers In Travel | Destination Planners") would
  // otherwise produce ambiguous 3-piece fingerprints.
  s = s.replace(/[.,()/\\&|]+/g, ' ')
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

// Tokens that look meaningful but are too generic to identify a company on their
// own. If the first token of the normalized name is one of these (and there's a
// more distinctive token later), we skip past it when picking the stem.
const QUALIFIER_STOPWORDS = new Set([
  'tech', 'soft', 'data', 'cloud', 'digital', 'global', 'group', 'labs', 'lab',
  'media', 'inter', 'world', 'the', 'and', 'pro', 'plus', 'one', 'first', 'next',
  'house', 'agency', 'studio', 'works', 'company', 'corp',
])

// "Luxoft", "Luxoft Poland" and "Luxoft DXC" all share a distinctive root token
// "luxoft". We pick the first sufficiently long, non-stopword token as the stem;
// callers index groups by stem and use companiesCompatible() to verify the rest.
export function companyStem(normalizedCompany: string): string {
  const tokens = normalizedCompany.split(/\s+/).filter(Boolean)
  for (const t of tokens) {
    if (t.length >= 4 && !QUALIFIER_STOPWORDS.has(t)) return t
  }
  return tokens[0] ?? ''
}

// True if two normalized company strings likely describe the same employer.
// Used as the second gate after a shared canonical_stem: catches "luxoft" vs
// "luxoft poland" (subset) and "luxoft poland" vs "luxoft dxc" (shared root).
export function companiesCompatible(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const aTokens = new Set(a.split(/\s+/).filter(Boolean))
  const bTokens = new Set(b.split(/\s+/).filter(Boolean))
  const [small, large] = aTokens.size <= bTokens.size ? [aTokens, bTokens] : [bTokens, aTokens]
  let subset = true
  for (const t of small) if (!large.has(t)) { subset = false; break }
  if (subset) return true
  // Both sides have unique tokens — accept if they share at least one
  // distinctive (length ≥ 4) root token.
  let sharedSignificant = 0
  for (const t of small) if (large.has(t) && t.length >= 4) sharedSignificant++
  return sharedSignificant >= 1
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
