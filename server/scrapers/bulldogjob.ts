import type {
	JobScraper,
	RawJob,
	ScrapeContext,
	ScrapeResult,
	ContractType,
	Experience,
} from "./types";

const SLUG_PAGES = [
	"https://bulldogjob.com/companies/jobs/s/skills,Vue.js",
	"https://bulldogjob.com/companies/jobs/s/category,frontend",
	"https://bulldogjob.com/companies/jobs/s/skills,React",
	"https://bulldogjob.com/companies/jobs/s/skills,JavaScript",
];

const HEADERS: HeadersInit = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
	"Accept-Language": "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",
	"Accept-Encoding": "gzip, deflate, br",
	"Cache-Control": "max-age=0",
	"Upgrade-Insecure-Requests": "1",
};

interface BdListJob {
	id: string;
	position: string;
	company: { name: string; logo?: { url: string } };
	city?: string;
	remote?: boolean;
	experienceLevel?: string;
	technologyTags?: string[];
	denominatedSalaryLong?: {
		money?: string;
		currency?: string;
		hidden?: boolean;
	};
	contractB2b?: { minValue?: number; maxValue?: number } | null;
	contractEmployment?:
		| boolean
		| { minValue?: number; maxValue?: number }
		| null;
}

function extractNextData(html: string): unknown {
	const m = html.match(
		/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
	);
	if (!m) throw new Error("__NEXT_DATA__ not found");
	return JSON.parse(m[1]);
}

function mapExperience(level?: string): Experience | undefined {
	if (!level) return undefined;
	const k = level.toLowerCase();
	if (k.includes("junior")) return "junior";
	if (k.includes("senior") || k.includes("expert") || k.includes("lead"))
		return "senior";
	if (k.includes("mid") || k.includes("regular")) return "mid";
	return undefined;
}

function pickSalaryFromList(j: BdListJob): {
	min?: number;
	max?: number;
	currency?: string;
	contractType?: ContractType;
} {
	const cur = j.denominatedSalaryLong?.currency;
	if (j.contractB2b && typeof j.contractB2b === "object") {
		const b = j.contractB2b as { minValue?: number; maxValue?: number };
		if (b.minValue || b.maxValue)
			return { min: b.minValue, max: b.maxValue, currency: cur, contractType: "b2b" };
	}
	if (j.contractEmployment && typeof j.contractEmployment === "object") {
		const e = j.contractEmployment as { minValue?: number; maxValue?: number };
		if (e.minValue || e.maxValue)
			return { min: e.minValue, max: e.maxValue, currency: cur, contractType: "permanent" };
	}
	return {};
}

interface NextDataShape {
	props: { pageProps: { jobs?: BdListJob[] } };
}

async function fetchListPage(
	url: string,
	signal?: AbortSignal,
): Promise<BdListJob[]> {
	const res = await fetch(url, { headers: HEADERS, signal });
	if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
	const html = await res.text();
	const data = extractNextData(html) as NextDataShape;
	return data.props?.pageProps?.jobs ?? [];
}

const LIST_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export const bulldogjobScraper: JobScraper = {
	source: "bulldogjob",
	displayName: "Bulldogjob",
	capabilities: { needsBrowser: false, supportsKeywordFilter: true },

	async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
		const errors: string[] = [];
		const jobs: RawJob[] = [];
		const seenIds = new Set<string>();

		for (const url of SLUG_PAGES) {
			try {
				const page = await fetchListPage(url, ctx.signal);
				for (const j of page) {
					if (seenIds.has(j.id)) continue;
					seenIds.add(j.id);
					const sal = pickSalaryFromList(j);
					jobs.push({
						source: "bulldogjob",
						sourceId: j.id,
						url: `https://bulldogjob.com/companies/jobs/${j.id}`,
						title: j.position,
						company: j.company?.name ?? "",
						location: j.city,
						remote: !!j.remote,
						salaryMin: sal.min,
						salaryMax: sal.max,
						currency: sal.currency,
						salaryPeriod: "month",
						contractType: sal.contractType,
						experience: mapExperience(j.experienceLevel),
						description: "",
						skills: j.technologyTags ?? [],
					});
					if (ctx.maxResults && jobs.length >= ctx.maxResults) {
						return { source: this.source, jobs, errors };
					}
				}
			} catch (e) {
				errors.push(`list ${url}: ${(e as Error).message}`);
			}
			await sleep(LIST_DELAY_MS);
		}

		return { source: this.source, jobs, errors };
	},
};
