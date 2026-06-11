<script setup lang="ts">
type Mode = 'b2b' | 'uop_gross' | 'uop_net'

const mode = ref<Mode>('b2b')
const inputVal = ref(100)
const hoursPerMonth = ref(168)
const usdRate = ref(4.0)
const eurRate = ref(4.25)
const ratesDate = ref('')

const modeDefaults: Record<Mode, number> = { b2b: 100, uop_gross: 10000, uop_net: 7000 }

watch(mode, (m) => { inputVal.value = modeDefaults[m] })

function uopGrossToNet(gross: number): number {
	if (gross <= 0) return 0
	const zus = gross * 0.1371
	const healthBase = gross - zus
	const health = healthBase * 0.09
	const taxBase = Math.max(0, healthBase - 250)
	const tax = Math.max(0, taxBase * 0.12 - 300)
	return gross - zus - health - tax
}

function uopNetToGross(net: number): number {
	if (net <= 0) return 0
	let lo = net, hi = net * 2.5
	for (let i = 0; i < 80; i++) {
		const mid = (lo + hi) / 2
		if (uopGrossToNet(mid) < net) lo = mid
		else hi = mid
	}
	return (lo + hi) / 2
}

const monthlyGross = computed(() => {
	const v = inputVal.value || 0
	if (mode.value === 'b2b') return v * hoursPerMonth.value
	if (mode.value === 'uop_gross') return v
	return uopNetToGross(v)
})

const monthlyNet = computed<number | null>(() => {
	if (mode.value === 'b2b') return null
	if (mode.value === 'uop_gross') return uopGrossToNet(inputVal.value || 0)
	return inputVal.value || 0
})

const hourly = computed(() => {
	if (mode.value === 'b2b') return inputVal.value || 0
	return (hoursPerMonth.value > 0) ? monthlyGross.value / hoursPerMonth.value : 0
})

const yearly = computed(() => monthlyGross.value * 12)

function fmt(pln: number) {
	return Math.round(pln).toLocaleString('pl-PL')
}

function row(label: string, pln: number, isNet = false) {
	return {
		label,
		pln: fmt(pln),
		usd: fmt(pln / usdRate.value),
		eur: fmt(pln / eurRate.value),
		isNet,
	}
}

const isUop = computed(() => mode.value !== 'b2b')

const rows = computed(() => {
	const tag = isUop.value ? 'brutto' : 'netto'
	const r = [
		row(`/h ${tag}`, hourly.value),
		row(`/mies. ${tag}`, monthlyGross.value),
	]
	if (monthlyNet.value !== null) {
		r.push(row('/mies. netto', monthlyNet.value, true))
	}
	r.push(row(`/rok ${tag}`, yearly.value))
	return r
})

const inputLabel = computed(() => {
	if (mode.value === 'b2b') return 'Stawka/h (netto)'
	if (mode.value === 'uop_gross') return 'Brutto/mies.'
	return 'Netto/mies.'
})

onMounted(async () => {
	try {
		const data = await $fetch<Array<{ rates: Array<{ code: string; mid: number }>; effectiveDate: string }>>(
			'https://api.nbp.pl/api/exchangerates/tables/A/?format=json'
		)
		const rates = data?.[0]?.rates ?? []
		const usd = rates.find(r => r.code === 'USD')
		const eur = rates.find(r => r.code === 'EUR')
		if (usd) usdRate.value = usd.mid
		if (eur) eurRate.value = eur.mid
		ratesDate.value = data?.[0]?.effectiveDate ?? ''
	} catch {
		// use defaults
	}
})
</script>

<template>
	<div class="salary-calc">
		<div class="sc-head">
			<span class="sc-title">Kalkulator stawki</span>
		</div>

		<div class="sc-modes">
			<button
				v-for="m in (['b2b', 'uop_gross', 'uop_net'] as const)"
				:key="m"
				class="sc-mode-btn"
				:class="{ active: mode === m }"
				@click="mode = m"
			>
				{{ m === 'b2b' ? 'B2B netto' : m === 'uop_gross' ? 'UoP brutto' : 'UoP netto' }}
			</button>
		</div>

		<div class="sc-inputs">
			<label class="sc-field sc-field-main">
				<span class="sc-label">{{ inputLabel }}</span>
				<div class="sc-input-wrap">
					<input
						v-model.number="inputVal"
						type="number"
						min="0"
						step="any"
						class="sc-input"
					/>
					<span class="sc-unit">PLN</span>
				</div>
			</label>
			<label class="sc-field">
				<span class="sc-label">h/mies.</span>
				<input
					v-model.number="hoursPerMonth"
					type="number"
					min="1"
					max="300"
					class="sc-input sc-input-small"
				/>
			</label>
		</div>

		<table class="sc-table">
			<thead>
				<tr>
					<th class="sc-th-label"></th>
					<th>PLN</th>
					<th>USD</th>
					<th>EUR</th>
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="r in rows"
					:key="r.label"
					:class="{ 'sc-net-row': r.isNet }"
				>
					<td class="sc-row-label">{{ r.label }}</td>
					<td class="sc-val">{{ r.pln }}</td>
					<td class="sc-val sc-val-muted">{{ r.usd }}</td>
					<td class="sc-val sc-val-muted">{{ r.eur }}</td>
				</tr>
			</tbody>
		</table>

		<div class="sc-rates">
			<span>NBP: USD&nbsp;{{ usdRate.toFixed(4) }} · EUR&nbsp;{{ eurRate.toFixed(4) }}</span>
			<span v-if="ratesDate" class="sc-rates-date">{{ ratesDate }}</span>
			<span v-else class="sc-rates-date">szacunkowe</span>
		</div>
	</div>
</template>

<style scoped>
.salary-calc {
	background: var(--card);
	border: 1px solid var(--border);
	border-radius: 0.5rem;
	padding: 0.9rem 1rem;
}

.sc-head {
	margin-bottom: 0.65rem;
}

.sc-title {
	font-size: 0.9rem;
	font-weight: 600;
}

.sc-modes {
	display: flex;
	gap: 0.3rem;
	margin-bottom: 0.75rem;
}

.sc-mode-btn {
	flex: 1;
	padding: 0.3rem 0.4rem;
	font-size: 0.75rem;
	background: transparent;
	border: 1px solid var(--border);
	border-radius: 0.35rem;
	color: var(--muted);
	cursor: pointer;
	transition: border-color 0.15s, color 0.15s, background 0.15s;
	white-space: nowrap;
}

.sc-mode-btn:hover {
	border-color: var(--accent);
	color: var(--fg);
}

.sc-mode-btn.active {
	background: var(--accent);
	border-color: var(--accent);
	color: #fff;
	font-weight: 600;
}

.sc-inputs {
	display: flex;
	gap: 0.5rem;
	margin-bottom: 0.75rem;
	align-items: flex-end;
}

.sc-field {
	display: flex;
	flex-direction: column;
	gap: 0.25rem;
}

.sc-field-main {
	flex: 1;
}

.sc-label {
	font-size: 0.72rem;
	color: var(--muted);
}

.sc-input-wrap {
	display: flex;
	align-items: center;
	background: var(--bg);
	border: 1px solid var(--border);
	border-radius: 0.35rem;
	overflow: hidden;
}

.sc-input-wrap .sc-input {
	border: none;
	background: transparent;
	flex: 1;
	min-width: 0;
}

.sc-unit {
	padding: 0 0.5rem;
	font-size: 0.75rem;
	color: var(--muted);
	border-left: 1px solid var(--border);
	height: 100%;
	display: flex;
	align-items: center;
	background: var(--bg);
}

.sc-input {
	padding: 0.3rem 0.5rem;
	font-size: 0.82rem;
	color: var(--fg);
	background: var(--bg);
	border: 1px solid var(--border);
	border-radius: 0.35rem;
	width: 100%;
	font-family: inherit;
}

.sc-input-wrap .sc-input {
	border: none;
	border-radius: 0;
}

.sc-input-small {
	width: 3.8rem;
}

.sc-input:focus {
	outline: none;
	border-color: var(--accent);
}

.sc-input-wrap:focus-within {
	border-color: var(--accent);
}

/* hide number arrows */
.sc-input::-webkit-outer-spin-button,
.sc-input::-webkit-inner-spin-button {
	-webkit-appearance: none;
}
.sc-input[type=number] { -moz-appearance: textfield; }

.sc-table {
	width: 100%;
	border-collapse: collapse;
	font-size: 0.82rem;
	margin-bottom: 0.6rem;
}

.sc-table thead th {
	text-align: right;
	color: var(--muted);
	font-size: 0.72rem;
	font-weight: 500;
	padding: 0 0.3rem 0.35rem;
	border-bottom: 1px solid var(--border);
}

.sc-th-label {
	text-align: left !important;
}

.sc-table tbody tr {
	border-bottom: 1px solid var(--border);
}

.sc-table tbody tr:last-child {
	border-bottom: none;
}

.sc-row-label {
	color: var(--muted);
	padding: 0.3rem 0.3rem 0.3rem 0;
	white-space: nowrap;
	font-size: 0.78rem;
}

.sc-val {
	text-align: right;
	padding: 0.3rem 0.3rem;
	font-variant-numeric: tabular-nums;
	font-weight: 500;
}

.sc-val-muted {
	color: var(--muted);
	font-weight: 400;
}

.sc-net-row .sc-val {
	color: var(--vue);
	font-weight: 600;
}

.sc-net-row .sc-val-muted {
	color: var(--vue);
	opacity: 0.75;
	font-weight: 500;
}

.sc-net-row .sc-row-label {
	color: var(--vue);
	opacity: 0.85;
}

.sc-rates {
	display: flex;
	justify-content: space-between;
	font-size: 0.7rem;
	color: var(--muted);
	opacity: 0.7;
}

.sc-rates-date {
	color: var(--muted);
}
</style>
