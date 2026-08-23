import streamDeck, { action, DidReceiveSettingsEvent, KeyDownEvent, KeyUpEvent, SendToPluginEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import {
	centeredTextPath, DataSourceItem, getDataArray, getSiteItems, getUptimeDetails, isObject,
	nestedValue, requestLegacy, requestUniFi, setKeyImage, stringField, ThroughputSettings, validColor
} from "./live-throughput";

const HOLD_MS = 700;
const DEFAULT_BACKGROUND = "#17172b";
const DEFAULT_ACCENT = "#20e3b2";
const INDIVIDUAL_METRICS = ["speed", "experience", "usage", "signal", "connection", "channel", "retries", "uptime", "bandwidth"] as const;
const SUMMARY_METRICS = ["total", "connection", "guest", "network"] as const;

type ClientSettings = ThroughputSettings & {
	mode?: "individual" | "summary";
	clientId?: string;
	clientSearch?: string;
	individualMetric?: number;
	summaryMetric?: number;
};
type RecordValue = Record<string, unknown>;
type ClientRequest = { event?: string };

@action({ UUID: "com.deadfrog-studios.ubiquitous.client-metrics" })
export class ClientMetrics extends SingletonAction<ClientSettings> {
	readonly #timers = new Map<string, NodeJS.Timeout>();
	readonly #refreshing = new Set<string>();
	readonly #pressedAt = new Map<string, number>();
	readonly #clientUrls = new Map<string, string>();

	override async onWillAppear(ev: WillAppearEvent<ClientSettings>): Promise<void> { await this.#restart(ev.action.id, ev.payload.settings); }
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ClientSettings>): Promise<void> { await this.#restart(ev.action.id, ev.payload.settings); }
	override onWillDisappear(ev: WillDisappearEvent<ClientSettings>): void { this.#stop(ev.action.id); }
	override onKeyDown(ev: KeyDownEvent<ClientSettings>): void { this.#pressedAt.set(ev.action.id, Date.now()); }

	override async onKeyUp(ev: KeyUpEvent<ClientSettings>): Promise<void> {
		const duration = Date.now() - (this.#pressedAt.get(ev.action.id) ?? Date.now());
		this.#pressedAt.delete(ev.action.id);
		if (duration < HOLD_MS) return;
		const url = this.#clientUrls.get(ev.action.id);
		if (!url) return void await ev.action.showAlert();
		await streamDeck.system.openUrl(url);
	}

	override async onSendToPlugin(ev: SendToPluginEvent<ClientRequest, ClientSettings>): Promise<void> {
		if (ev.payload.event !== "getSites" && ev.payload.event !== "getClients") return;
		try {
			const settings = await ev.action.getSettings<ClientSettings>();
			let items: DataSourceItem[];
			if (ev.payload.event === "getSites") {
				items = await getSiteItems(settings);
				if (items.length && !items.some(({ value }) => value === settings.siteId)) {
					settings.siteId = items[0].value;
					settings.clientId = undefined;
					await ev.action.setSettings(settings);
				}
			} else {
				if (!settings.siteId) {
					const sites = await getSiteItems(settings);
					if (!sites.length) throw new Error("No sites found");
					settings.siteId = sites[0].value;
					await ev.action.setSettings(settings);
				}
				items = await getClientItems(settings);
				if (items.length && !items.some(({ value }) => value === settings.clientId)) {
					settings.clientId = items[0].value;
					await ev.action.setSettings(settings);
				}
			}
			await streamDeck.ui.sendToPropertyInspector({ event: ev.payload.event, items });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await streamDeck.ui.sendToPropertyInspector({ event: ev.payload.event, items: [{ label: `Unable to load: ${message}`, value: "", disabled: true }] });
		}
	}

	async #restart(id: string, settings: ClientSettings): Promise<void> {
		this.#stop(id);
		await this.#refresh(id);
		const seconds = Math.max(1, Number(settings.pollIntervalSeconds) || 5);
		this.#timers.set(id, setInterval(() => void this.#refresh(id), seconds * 1000));
	}

	#stop(id: string): void { const timer = this.#timers.get(id); if (timer) clearInterval(timer); this.#timers.delete(id); }

	async #refresh(id: string): Promise<void> {
		if (this.#refreshing.has(id)) return;
		const key = this.actions.find((candidate) => candidate.id === id);
		if (!key?.isKey()) return;
		this.#refreshing.add(id);
		try {
			const settings = await key.getSettings<ClientSettings>();
			if (!configured(settings) || (settings.mode !== "summary" && !settings.clientId)) {
				await setKeyImage(key, messageTile("CONFIGURE", "CLIENT", settings.backgroundColor));
				return;
			}
			const legacyClients = await getLegacyClients(settings);
			if (settings.mode === "summary") {
				this.#clientUrls.delete(id);
				await setKeyImage(key, renderSummary(legacyClients, Number(settings.summaryMetric) || 0, settings));
				return;
			}
			const detail = unwrap(await requestUniFi(settings, `/v1/sites/${encodeURIComponent(settings.siteId!)}/clients/${encodeURIComponent(settings.clientId!)}`));
			const legacy = matchLegacy(legacyClients, detail);
			this.#clientUrls.set(id, clientUrl(settings, detail, legacy));
			await setKeyImage(key, renderIndividual(detail, legacy, Number(settings.individualMetric) || 0, settings));
		} catch (error) {
			console.error(`Unable to update Client Metrics ${id}: ${error instanceof Error ? error.message : String(error)}`);
			await setKeyImage(key, messageTile("CLIENT", "ERROR"));
			await key.showAlert();
		} finally { this.#refreshing.delete(id); }
	}
}

function configured(settings: ClientSettings): boolean {
	return Boolean(settings.udmAddress?.trim() && settings.apiKey?.trim() && settings.siteId?.trim());
}

async function getClientItems(settings: ClientSettings): Promise<DataSourceItem[]> {
	const clients = getDataArray(await requestUniFi(settings, `/v1/sites/${encodeURIComponent(settings.siteId!)}/clients?limit=200`));
	const search = settings.clientSearch?.trim().toLowerCase() ?? "";
	const items = clients.map((client) => {
		const name = clientName(client);
		const ip = firstString(client, ["ipAddress", "ip"]);
		const mac = firstString(client, ["macAddress", "mac"]);
		return { label: `${name}${ip ? ` — ${ip}` : ""}`, value: stringField(client, "id"), search: `${name} ${ip} ${mac}`.toLowerCase() };
	}).filter(({ value, search: valueSearch }) => value && (!search || valueSearch.includes(search)))
		.map(({ label, value }) => ({ label, value }));
	if (!items.length) throw new Error(search ? `No connected clients match '${settings.clientSearch}'` : "No connected clients found");
	return items;
}

async function getLegacyClients(settings: ClientSettings): Promise<RecordValue[]> {
	try {
		const clients = getDataArray(await requestLegacy(settings, "/stat/sta"));
		if (clients.length) return clients;
	} catch { /* Use the supported Integration API fallback below. */ }
	try { return getDataArray(await requestUniFi(settings, `/v1/sites/${encodeURIComponent(settings.siteId!)}/clients?limit=200`)); }
	catch { return []; }
}

function unwrap(value: unknown): RecordValue {
	if (isObject(value) && isObject(value.data)) return value.data;
	if (isObject(value) && !Array.isArray(value.data)) return value;
	const rows = getDataArray(value);
	if (!rows.length) throw new Error("UniFi returned no client details");
	return rows[0];
}

function matchLegacy(clients: RecordValue[], detail: RecordValue): RecordValue | undefined {
	const mac = normalizeMac(firstString(detail, ["macAddress", "mac"]));
	const ip = firstString(detail, ["ipAddress", "ip"]);
	return clients.find((client) => normalizeMac(firstString(client, ["mac", "macAddress"])) === mac && mac)
		?? clients.find((client) => firstString(client, ["ip", "ipAddress"]) === ip && ip);
}

function renderIndividual(detail: RecordValue, legacy: RecordValue | undefined, metricIndex: number, settings: ClientSettings): string {
	const metric = INDIVIDUAL_METRICS[((metricIndex % INDIVIDUAL_METRICS.length) + INDIVIDUAL_METRICS.length) % INDIVIDUAL_METRICS.length];
	const records = [detail, legacy];
	const name = clientName(detail, legacy);
	const accent = validColor(settings.graphColor, DEFAULT_ACCENT);
	const background = validColor(settings.backgroundColor, DEFAULT_BACKGROUND);
	if (metric === "speed") {
		const mbps = optionalNumber(records, ["connectionSpeedMbps", "linkSpeedMbps", "tx_rate", "rx_rate"]);
		return valueTile(name, "CONNECTION", mbps === undefined ? "—" : String(Math.round(normalizeRateMbps(mbps))), "Mb/s", accent, background);
	}
	if (metric === "experience") {
		const score = optionalNumber(records, ["experienceScore", "satisfaction", "wifi_experience_score"]);
		const color = score === undefined ? accent : score >= 80 ? "#12c892" : score >= 60 ? "#ffd23f" : "#ff4057";
		return valueTile(name, "EXPERIENCE", score === undefined ? "—" : String(Math.round(score)), "%", color, background);
	}
	if (metric === "usage") {
		const bytes = (optionalNumber(records, ["rxBytes", "rx_bytes"]) ?? 0)
			+ (optionalNumber(records, ["txBytes", "tx_bytes"]) ?? 0);
		const formatted = formatBytes(bytes);
		return valueTile(name, "DATA USAGE", formatted.value, formatted.unit, accent, background);
	}
	if (metric === "signal") {
		const signal = optionalNumber(records, ["signalDbm", "signal", "rssi"]);
		const color = signal === undefined ? accent : signal >= -60 ? "#12c892" : signal >= -75 ? "#ffd23f" : "#ff4057";
		return valueTile(name, "SIGNAL", signal === undefined ? "—" : String(Math.round(signal)), "dBm", color, background);
	}
	if (metric === "connection") {
		const point = firstFrom(records, ["accessPointName", "connectedDeviceName", "ap_name", "sw_name", "hostname"]) || "UNKNOWN";
		return textTile(name, "CONNECTED TO", point, accent, background);
	}
	if (metric === "channel") {
		const channel = optionalNumber(records, ["channel", "radio.channel"]);
		return valueTile(name, "WIFI CHANNEL", channel === undefined ? "—" : String(Math.round(channel)), "", accent, background);
	}
	if (metric === "retries") {
		const retries = optionalNumber(records, ["txRetryPct", "txRetriesPct", "tx_retries", "tx_retry"]);
		return valueTile(name, "TX RETRIES", retries === undefined ? "—" : String(Math.round(retries)), "%", accent, background);
	}
	if (metric === "uptime") {
		const seconds = optionalNumber(records, ["uptimeSec", "uptime", "connectedAt"]);
		return uptimeTile(name, seconds ?? 0, accent, background);
	}
	const down = optionalNumber(records, ["downlinkRateBps", "rxRateBps", "rx_bytes-r", "rx_bytes_r"]) ?? 0;
	const up = optionalNumber(records, ["uplinkRateBps", "txRateBps", "tx_bytes-r", "tx_bytes_r"]) ?? 0;
	return bandwidthTile(name, normalizeBps(down), normalizeBps(up), accent, background);
}

function renderSummary(clients: RecordValue[], metricIndex: number, settings: ClientSettings): string {
	const metric = SUMMARY_METRICS[((metricIndex % SUMMARY_METRICS.length) + SUMMARY_METRICS.length) % SUMMARY_METRICS.length];
	const accent = validColor(settings.graphColor, DEFAULT_ACCENT);
	const background = validColor(settings.backgroundColor, DEFAULT_BACKGROUND);
	if (metric === "total") return valueTile("ALL CLIENTS", "CONNECTED", String(clients.length), "", accent, background);
	if (metric === "connection") {
		const wired = clients.filter(isWired).length;
		return splitTile("CLIENTS", "WIRED", wired, "WIRELESS", clients.length - wired, accent, background);
	}
	if (metric === "guest") {
		const guests = clients.filter(isGuest).length;
		return splitTile("CLIENTS", "GUEST", guests, "REGULAR", clients.length - guests, accent, background);
	}
	const counts = new Map<string, number>();
	for (const client of clients) {
		const network = firstString(client, ["essid", "network", "network_name", "vlan_name"]) || "LAN";
		counts.set(network, (counts.get(network) ?? 0) + 1);
	}
	return networkTile([...counts].sort((a, b) => b[1] - a[1]).slice(0, 3), accent, background);
}

function clientName(primary: RecordValue, fallback?: RecordValue): string {
	return firstFrom([primary, fallback], ["name", "displayName", "hostname", "ipAddress", "ip"]) || "CLIENT";
}
function firstString(record: RecordValue, fields: string[]): string { for (const field of fields) { const value = nestedValue(record, field.split(".")); if (typeof value === "string" && value) return value; } return ""; }
function firstFrom(records: Array<RecordValue | undefined>, fields: string[]): string { for (const record of records) { if (record) { const value = firstString(record, fields); if (value) return value; } } return ""; }
function optionalNumber(records: Array<RecordValue | undefined>, fields: string[]): number | undefined { for (const record of records) { if (!record) continue; for (const field of fields) { const value = nestedValue(record, field.split(".")); if (typeof value === "number" && Number.isFinite(value)) return value; } } return undefined; }
function normalizeMac(value: string): string { return value.replace(/[^a-f0-9]/gi, "").toLowerCase(); }
function normalizeRateMbps(value: number): number { return value > 100_000 ? value / 1_000_000 : value > 10_000 ? value / 1000 : value; }
function normalizeBps(value: number): number { return Math.max(0, value < 100_000 ? value * 8 : value); }
function isWired(client: RecordValue): boolean { return client.is_wired === true || client.isWired === true || /wired/i.test(firstString(client, ["type", "connectionType"])); }
function isGuest(client: RecordValue): boolean { return client.is_guest === true || client.isGuest === true || /guest/i.test(firstString(client, ["network", "essid"])); }

function clientUrl(settings: ClientSettings, detail: RecordValue, legacy?: RecordValue): string {
	const raw = settings.udmAddress!.trim();
	const url = new URL(raw.match(/^https?:\/\//i) ? raw : `https://${raw}`);
	const mac = firstFrom([detail, legacy], ["macAddress", "mac"]);
	url.pathname = mac ? `/network/default/clients/${encodeURIComponent(mac)}` : "/network/default/clients";
	url.search = ""; url.hash = "";
	return url.toString();
}

function formatBytes(bytes: number): { value: string; unit: string } {
	if (bytes >= 1e12) return { value: (bytes / 1e12).toFixed(1), unit: "TB" };
	if (bytes >= 1e9) return { value: (bytes / 1e9).toFixed(1), unit: "GB" };
	return { value: (bytes / 1e6).toFixed(1), unit: "MB" };
}
function shell(background: string, body: string): string { return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect x="10" y="10" width="124" height="124" rx="23" fill="${background}" stroke="#4b4b4d" stroke-width="5"/>${body}</svg>`; }
function heading(name: string): string { const text = name.toUpperCase(); return `<path d="${centeredTextPath(text, text.length > 16 ? 10 : text.length > 11 ? 13 : 16, 72, 34)}" fill="#fff"/>`; }
function valueTile(name: string, label: string, value: string, unit: string, accent: string, background: string): string { const size = value.length > 6 ? 35 : 54; return shell(background, `${heading(name)}<path d="${centeredTextPath(label, 14, 72, 54)}" fill="#fff"/><path d="${centeredTextPath(value, size, 72, 101)}" fill="${accent}" stroke="#08080a" stroke-width=".5" paint-order="stroke"/>${unit ? `<path d="${centeredTextPath(unit, 14, 72, 121)}" fill="${accent}"/>` : ""}`); }
function textTile(name: string, label: string, value: string, accent: string, background: string): string { const size = value.length > 16 ? 12 : value.length > 11 ? 16 : 22; return shell(background, `${heading(name)}<path d="${centeredTextPath(label, 14, 72, 58)}" fill="#fff"/><path d="${centeredTextPath(value.toUpperCase(), size, 72, 96)}" fill="${accent}"/>`); }
function uptimeTile(name: string, seconds: number, accent: string, background: string): string { const value = getUptimeDetails(seconds); return shell(background, `${heading(name)}<path d="${centeredTextPath(String(value.days), 49, 72, 82)}" fill="${accent}"/><path d="${centeredTextPath("DAYS", 14, 72, 103)}" fill="${accent}"/><path d="${centeredTextPath(`${value.hours}h ${value.minutes}m`, 16, 72, 123)}" fill="#fff"/>`); }
function bandwidthTile(name: string, down: number, up: number, accent: string, background: string): string { const downText = String(Math.round(down / 1e6)); const upText = String(Math.round(up / 1e6)); return shell(background, `${heading(name)}<path d="${centeredTextPath("↓", 20, 25, 72)}" fill="${accent}"/><path d="${centeredTextPath(downText, 30, 67, 73)}" fill="#fff"/><path d="${centeredTextPath("↑", 20, 25, 108)}" fill="#39b9ff"/><path d="${centeredTextPath(upText, 30, 67, 109)}" fill="#fff"/><path d="${centeredTextPath("Mb/s", 12, 111, 91)}" fill="#fff"/>`); }
function splitTile(title: string, leftLabel: string, left: number, rightLabel: string, right: number, accent: string, background: string): string { return shell(background, `${heading(title)}<path d="${centeredTextPath(leftLabel, 11, 38, 59)}" fill="#fff"/><path d="${centeredTextPath(rightLabel, 11, 104, 59)}" fill="#fff"/><path d="${centeredTextPath(String(left), 37, 38, 101)}" fill="${accent}"/><path d="${centeredTextPath(String(right), 37, 104, 101)}" fill="#39b9ff"/>`); }
function networkTile(networks: Array<[string, number]>, accent: string, background: string): string { const rows = networks.length ? networks : [["NO CLIENTS", 0] as [string, number]]; return shell(background, `${heading("BY NETWORK")}${rows.map(([name, count], index) => { const y = 62 + index * 28; const clipped = name.length > 12 ? `${name.slice(0, 11)}…` : name; return `<path d="${centeredTextPath(clipped.toUpperCase(), 12, 52, y)}" fill="#fff"/><path d="${centeredTextPath(String(count), 22, 108, y)}" fill="${accent}"/>`; }).join("")}`); }
function messageTile(top: string, bottom: string, requestedBackground?: string): string { const background = validColor(requestedBackground, DEFAULT_BACKGROUND); return shell(background, `<path d="${centeredTextPath(top, 20, 72, 67)}" fill="#fff"/><path d="${centeredTextPath(bottom, 20, 72, 94)}" fill="#fff"/>`); }
