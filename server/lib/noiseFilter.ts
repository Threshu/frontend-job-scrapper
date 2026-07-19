// Filters out titles that are almost certainly not Vue-frontend roles even
// though the posting mentions Vue somewhere in its skills / description.
// Runs in JS post-fetch (list is already capped at ~500 rows) — this used to be
// 30+ LIKE '%pattern%' clauses in the main list query, forcing a full scan on
// canonical_title on every load.
//
// Rule: if Vue is in the title, the offer passes regardless — "Lead Vue
// Developer" stays even though "Lead" is on the noise list.

const NOISE_PATTERNS = [
  // Python jako główny język
  'python',
  // Java (ostrożnie — nie "javascript")
  'java developer', 'java engineer', 'fullstack java',
  // .NET/C# jako główny
  '.net developer', '.net engineer', '.net core', '.net full', '(.net', ' .net',
  // React jako główny frontend
  'react developer', 'react engineer', 'react native',
  // Inne języki backendowe
  'golang', 'kotlin developer', 'kotlin engineer', 'c++', 'ruby',
  // Role niedev
  'qa engineer', 'quality engineer', 'quality assurance',
  'tester manualny', 'engineer in test',
  'vice president', 'vp,', 'vp ',
  'head of ', 'chief ',
  'director', 'directeur', 'ingénierie',
  'telco', 'telecom',
  ' manager', ' analyst', ' designer',
  'support specialist', 'support engineer',
  'product owner', 'cloud consultant', 'devops',
  // Lead/architect
  'lead software engineer', 'lead full', 'tech lead', 'team lead',
  'solution architect', 'software architect', 'architecte',
  // PHP jako główny
  'php developer', 'php engineer',
  // Platformy e-commerce
  'shopify', 'magento', 'wordpress developer', 'wordpress engineer',
  'ecommerce',
]

export function isNoiseTitle(title: string): boolean {
  const lower = title.toLowerCase()
  // Vue in title exempts an offer from noise filtering.
  if (/\bvue(\.?js|2|3)?\b/i.test(title)) return false
  for (const p of NOISE_PATTERNS) {
    if (lower.includes(p)) return true
  }
  return false
}
