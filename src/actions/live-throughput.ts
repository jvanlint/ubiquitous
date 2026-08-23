import { request } from "node:https";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { parse as parseFont } from "opentype.js";
import streamDeck, { action, DidReceiveSettingsEvent, KeyDownEvent, KeyUpEvent, SendToPluginEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";

const DEFAULT_POLL_SECONDS = 5;
const MIN_POLL_SECONDS = 1;
const DEFAULT_GRAPH_COLOR = "#20e3b2";
const DEFAULT_BACKGROUND_COLOR = "#17172b";
const HISTORY_LENGTH = 32;
const HOLD_MILLISECONDS = 700;
const VIEWS = ["throughput", "monthly_usage", "ip", "uptime", "isp_uptime", "latency", "status"] as const;
const fontFile = readFileSync(new URL("../fonts/Play-Bold.ttf", import.meta.url));
const PLAY_BOLD = parseFont(fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength));

export type ThroughputSettings = {
	udmAddress?: string;
	apiKey?: string;
	siteId?: string;
	gatewayDeviceId?: string;
	pollIntervalSeconds?: number;
	allowSelfSignedCertificate?: boolean;
	graphColor?: string;
	backgroundColor?: string;
	viewIndex?: number;
	ipViewIndex?: number;
};

type Metric = typeof VIEWS[number];

type Throughput = {
	downloadBitsPerSecond: number;
	uploadBitsPerSecond: number;
};

type MetricDisplay = {
	label: string;
	value: string;
	graphValue?: number;
	copyText?: string;
	accentColor?: string;
	throughput?: Throughput;
	unit?: "GB" | "TB";
	uptimeDetails?: { days: number; hours: number; minutes: number };
	statusDetails?: { ispName: string; online: boolean };
};

export type DataSourceRequest = {
	event?: string;
	isRefresh?: boolean;
};

export type DataSourceItem = {
	label: string;
	value: string;
	disabled?: boolean;
};

/** Displays current WAN throughput reported by a UniFi gateway. */
@action({ UUID: "com.deadfrog-studios.ubiquitous.throughput" })
export class LiveThroughput extends SingletonAction<ThroughputSettings> {
	readonly #timers = new Map<string, NodeJS.Timeout>();
	readonly #refreshing = new Set<string>();
	readonly #history = new Map<string, { metric: Metric; values: number[] }>();
	readonly #pressedAt = new Map<string, number>();
	readonly #copyValues = new Map<string, string>();

	override async onWillAppear(ev: WillAppearEvent<ThroughputSettings>): Promise<void> {
		await this.#restart(ev.action.id, ev.payload.settings, () => this.#refresh(ev.action.id));
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ThroughputSettings>): Promise<void> {
		await this.#restart(ev.action.id, ev.payload.settings, () => this.#refresh(ev.action.id));
	}

	override onWillDisappear(ev: WillDisappearEvent<ThroughputSettings>): void {
		this.#stop(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<ThroughputSettings>): void {
		this.#pressedAt.set(ev.action.id, Date.now());
	}

	override async onKeyUp(ev: KeyUpEvent<ThroughputSettings>): Promise<void> {
		const heldFor = Date.now() - (this.#pressedAt.get(ev.action.id) ?? Date.now());
		this.#pressedAt.delete(ev.action.id);
		const settings = await ev.action.getSettings<ThroughputSettings>();
		const viewIndex = normalizeIndex(settings.viewIndex, VIEWS.length);
		if (heldFor >= HOLD_MILLISECONDS && VIEWS[viewIndex] === "ip") {
			const value = this.#copyValues.get(ev.action.id);
			if (value) {
				await copyToClipboard(value);
				if (ev.action.isKey()) await ev.action.showOk();
			} else await ev.action.showAlert();
			return;
		}

		if (VIEWS[viewIndex] === "ip") {
			const ipView = normalizeIndex(settings.ipViewIndex, 3);
			if (ipView < 2) settings.ipViewIndex = ipView + 1;
			else {
				settings.ipViewIndex = 0;
				settings.viewIndex = (viewIndex + 1) % VIEWS.length;
			}
		} else settings.viewIndex = (viewIndex + 1) % VIEWS.length;
		await ev.action.setSettings(settings);
		await this.#refresh(ev.action.id);
	}

	override async onSendToPlugin(ev: SendToPluginEvent<DataSourceRequest, ThroughputSettings>): Promise<void> {
		const event = ev.payload.event;
		if (event !== "getSites" && event !== "getGateways") return;

		try {
			const settings = await ev.action.getSettings<ThroughputSettings>();
			const items = event === "getSites"
				? await getSiteItems(settings)
				: await getGatewayItems(settings, async (siteId) => {
					settings.siteId = siteId;
					settings.gatewayDeviceId = undefined;
					await ev.action.setSettings(settings);
				});
			if (event === "getGateways" && items.length > 0
				&& !items.some((item) => item.value === settings.gatewayDeviceId)) {
				// sdpi-select displays its first data-source item when there is no
				// persisted value, but that visual default is not saved automatically.
				settings.gatewayDeviceId = items[0].value;
				await ev.action.setSettings(settings);
			}
			await streamDeck.ui.sendToPropertyInspector({ event, items });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await streamDeck.ui.sendToPropertyInspector({
				event,
				items: [{ label: `Unable to load: ${message}`, value: "", disabled: true }]
			});
		}
	}

	async #restart(contextId: string, settings: ThroughputSettings, refresh: () => Promise<void>): Promise<void> {
		this.#stop(contextId);
		await refresh();

		const pollSeconds = Math.max(MIN_POLL_SECONDS, Number(settings.pollIntervalSeconds) || DEFAULT_POLL_SECONDS);
		this.#timers.set(contextId, setInterval(() => void refresh(), pollSeconds * 1000));
	}

	#stop(contextId: string): void {
		const timer = this.#timers.get(contextId);
		if (timer) clearInterval(timer);
		this.#timers.delete(contextId);
	}

	async #refresh(contextId: string): Promise<void> {
		if (this.#refreshing.has(contextId)) return;

		const action = this.actions.find((candidate) => candidate.id === contextId);
		if (!action?.isKey()) return;

		this.#refreshing.add(contextId);
		try {
			const settings = await action.getSettings<ThroughputSettings>();
			if (!isConfigured(settings)) {
				await setKeyImage(action, renderStatusSvg("CONFIGURE", "UNIFI", settings.graphColor, settings.backgroundColor));
				return;
			}

			const metric = VIEWS[normalizeIndex(settings.viewIndex, VIEWS.length)];
			const display = await getMetricDisplay(metric, settings);
			if (display.copyText) this.#copyValues.set(contextId, display.copyText);
			else this.#copyValues.delete(contextId);
			const existing = this.#history.get(contextId);
			const history = display.graphValue === undefined
				? []
				: existing?.metric === metric ? existing.values : [];
			if (display.graphValue !== undefined) history.push(display.graphValue);
			if (history.length > HISTORY_LENGTH) history.splice(0, history.length - HISTORY_LENGTH);
			this.#history.set(contextId, { metric, values: history });
			const svg = display.throughput
				? renderThroughputSvg(display.throughput, history, settings.graphColor, settings.backgroundColor)
				: display.unit
					? renderMonthlyDataSvg(display.value, display.unit, settings.graphColor, settings.backgroundColor)
					: display.uptimeDetails
						? renderGatewayUptimeSvg(display.uptimeDetails, settings.graphColor, settings.backgroundColor)
						: display.statusDetails
							? renderNetworkStatusSvg(display.statusDetails, settings.backgroundColor)
							: renderMetricSvg(display.label, display.value, history, display.accentColor ?? settings.graphColor, settings.backgroundColor);
			await setKeyImage(action, svg);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`Unable to update UniFi throughput for action ${contextId}: ${message}`);
			await setKeyImage(action, renderStatusSvg("UNIFI", "ERROR"));
			await action.showAlert();
		} finally {
			this.#refreshing.delete(contextId);
		}
	}
}

function isConfigured(settings: ThroughputSettings): settings is Required<Pick<ThroughputSettings, "udmAddress" | "apiKey" | "siteId" | "gatewayDeviceId">> & ThroughputSettings {
	return Boolean(settings.udmAddress?.trim() && settings.apiKey?.trim() && settings.siteId?.trim() && settings.gatewayDeviceId?.trim());
}

function getLatestStatistics(settings: ThroughputSettings): Promise<unknown> {
	return requestUniFi(settings, `/v1/sites/${encodeURIComponent(settings.siteId!.trim())}/devices/${encodeURIComponent(settings.gatewayDeviceId!.trim())}/statistics/latest`);
}

async function getMetricDisplay(metric: Metric, settings: ThroughputSettings): Promise<MetricDisplay> {
	if (metric === "ip") {
		const ipView = normalizeIndex(settings.ipViewIndex, 3);
		if (ipView === 0) {
			const value = extractPublicIp(await requestLegacy(settings, "/stat/health"));
			return { label: "WAN IP", value, copyText: value };
		}
		if (ipView === 1) {
			const value = extractWanIpv6(await requestLegacy(settings, "/stat/device"));
			return { label: "WAN IPv6", value: value || "NOT SET", copyText: value || undefined };
		}
		const details = await requestUniFi(settings, `/v1/sites/${encodeURIComponent(settings.siteId!.trim())}/devices/${encodeURIComponent(settings.gatewayDeviceId!.trim())}`);
		const value = isObject(details) ? stringField(details, "ipAddress") : "";
		if (!value) throw new Error("Gateway details did not contain an IP address");
		return { label: "GATEWAY IP", value, copyText: value };
	}
	if (metric === "monthly_usage") {
		const bytes = await getMonthlyUsageBytes(settings);
		const terabytes = bytes / 1_000_000_000_000;
		return terabytes >= 1
			? { label: "WAN TOTAL", value: formatUsage(terabytes), unit: "TB" }
			: { label: "WAN TOTAL", value: formatUsage(bytes / 1_000_000_000), unit: "GB" };
	}

	if (metric === "uptime") {
		const stats = await getLatestStatistics(settings);
		const uptimeDetails = getUptimeDetails(extractNumber(stats, ["uptimeSec", "uptime"]));
		return { label: "GATEWAY UPTIME", value: uptimeDetails.days.toString(), uptimeDetails };
	}
	if (metric === "throughput") {
		const throughput = extractThroughput(await getLatestStatistics(settings));
		return {
			label: "THROUGHPUT",
			value: "",
			graphValue: throughput.downloadBitsPerSecond + throughput.uploadBitsPerSecond,
			throughput
		};
	}

	const wan = getWanHealth(await requestLegacy(settings, "/stat/health"));
	if (metric === "isp_uptime") {
		const availability = nestedNumber(wan, ["uptime_stats", "WAN", "availability"]);
		return { label: "ISP UPTIME", value: `${Math.round(availability)}%`, accentColor: availability >= 99 ? "#35e06f" : availability >= 95 ? "#ffd23f" : "#ff4057" };
	}
	if (metric === "latency") {
		const latency = nestedNumber(wan, ["uptime_stats", "WAN", "latency_average"]);
		return { label: "LATENCY MS", value: Math.round(latency).toString(), accentColor: latency <= 20 ? "#35e06f" : latency <= 50 ? "#ffd23f" : "#ff4057" };
	}
	const online = stringField(wan, "status").toLowerCase() === "ok";
	const ispName = stringField(wan, "isp_name") || "ISP";
	return {
		label: ispName,
		value: online ? "ONLINE" : "OFFLINE",
		accentColor: online ? "#35e06f" : "#ff4057",
		statusDetails: { ispName, online }
	};
}

export function requestUniFi(settings: ThroughputSettings, integrationPath: string): Promise<unknown> {
	return requestUdm(settings, `/proxy/network/integration${integrationPath}`);
}

export function requestLegacy(settings: ThroughputSettings, path: string, method = "GET", payload?: object): Promise<unknown> {
	return requestUdm(settings, `/proxy/network/api/s/default${path}`, method, payload);
}

function requestUdm(settings: ThroughputSettings, apiPath: string, method = "GET", payload?: object): Promise<unknown> {
	if (!settings.udmAddress?.trim() || !settings.apiKey?.trim()) {
		return Promise.reject(new Error("Enter the UDM address and API key first"));
	}
	const baseUrl = settings.udmAddress!.trim().match(/^https?:\/\//i)
		? settings.udmAddress!.trim()
		: `https://${settings.udmAddress!.trim()}`;
	const url = new URL(baseUrl);
	const [path, query = ""] = apiPath.split("?", 2);
	url.pathname = path;
	url.search = query;
	url.hash = "";

	if (url.protocol !== "https:") {
		return Promise.reject(new Error("The UDM address must use HTTPS"));
	}

	return new Promise((resolve, reject) => {
		const body = payload === undefined ? undefined : JSON.stringify(payload);
		const req = request(url, {
			method,
			headers: {
				Accept: "application/json",
				"X-API-Key": settings.apiKey!.trim(),
				...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) })
			},
			// Local UniFi consoles normally use a self-signed certificate. The PI's
			// checked default is not persisted until the user changes it, so undefined
			// must have the same meaning as the visually checked default.
			rejectUnauthorized: settings.allowSelfSignedCertificate === false,
			timeout: 10_000
		}, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				body += chunk;
				if (body.length > 2_000_000) req.destroy(new Error("UniFi response was too large"));
			});
			res.on("end", () => {
				if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
					const detail = getErrorDetail(body);
					reject(new Error(`UniFi returned HTTP ${res.statusCode ?? "unknown"}${detail ? `: ${detail}` : ""}`));
					return;
				}
				try { resolve(JSON.parse(body)); } catch { reject(new Error("UniFi returned invalid JSON")); }
			});
		});
		req.on("timeout", () => req.destroy(new Error("UniFi request timed out")));
		req.on("error", reject);
		req.end(body);
	});
}

async function getMonthlyUsageBytes(settings: ThroughputSettings): Promise<number> {
	const now = new Date();
	const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
	const response = await requestLegacy(settings, "/stat/report/monthly.site", "POST", {
		start,
		end: now.getTime(),
		attrs: ["time", "wan-tx_bytes", "wan-rx_bytes"]
	});
	const rows = getDataArray(response);
	return rows.reduce((total, row) => total + numberField(row, "wan-tx_bytes") + numberField(row, "wan-rx_bytes"), 0);
}

export async function getSiteItems(settings: ThroughputSettings): Promise<DataSourceItem[]> {
	const sites = await getSites(settings);
	const items = sites.map((site) => ({
		label: stringField(site, "name") || stringField(site, "internalReference") || stringField(site, "id"),
		value: getSiteUuid(site)
	})).filter((item) => item.value);
	if (items.length === 0) throw new Error("UniFi did not return a UUID for any site");
	return items;
}

async function getGatewayItems(settings: ThroughputSettings, repairSiteId: (siteId: string) => Promise<void>): Promise<DataSourceItem[]> {
	if (!settings.siteId?.trim()) throw new Error("Select a site first");
	if (!isUuid(settings.siteId)) {
		const sites = await getSites(settings);
		const siteIds = sites.map(getSiteUuid).filter(Boolean);
		if (siteIds.length !== 1) {
			throw new Error(`Select the site again; '${settings.siteId}' is not its UUID`);
		}
		settings.siteId = siteIds[0];
		await repairSiteId(settings.siteId);
	}
	// Some Network releases return HTTP 400 when pagination parameters are
	// supplied to this otherwise paginated endpoint, so use its defaults.
	const response = await requestUniFi(settings, `/v1/sites/${encodeURIComponent(settings.siteId.trim())}/devices`);
	const allDevices = getDataArray(response);
	const classifiedGateways = allDevices.filter(isGatewayDevice);
	// Older/early-access Network builds sometimes omit gateway classification
	// metadata. Showing their returned devices still lets the user select the
	// UDM by name/model and is better than an empty selector.
	const devices = classifiedGateways.length > 0 ? classifiedGateways : allDevices;
	if (devices.length === 0) throw new Error("No devices found at this site");
	return devices.map((device) => {
		const name = stringField(device, "name") || stringField(device, "model") || "Gateway";
		const model = stringField(device, "model");
		const fallback = classifiedGateways.length === 0 ? " [select gateway]" : "";
		return { label: `${model && model !== name ? `${name} (${model})` : name}${fallback}`, value: stringField(device, "id") };
	}).filter((item) => item.value);
}

function isGatewayDevice(device: Record<string, unknown>): boolean {
	// Current Integration API versions classify adopted devices using the
	// features array. Keep the type check for older Network releases.
	const features = device.features;
	const arrayHasGateway = Array.isArray(features) && features.some((feature) => {
		if (typeof feature === "string") return feature.toLowerCase() === "gateway";
		return isObject(feature) && ["type", "name", "feature"].some((field) => stringField(feature, field).toLowerCase() === "gateway");
	});
	const objectHasGateway = isObject(features)
		&& Object.keys(features).some((key) => key.toLowerCase() === "gateway");
	const identity = `${stringField(device, "model")} ${stringField(device, "name")}`;
	const gatewayModel = /\b(?:UDM|UCG|UXG|USG)[A-Z0-9-]*\b|dream machine|cloud gateway|security gateway/i.test(identity);
	return arrayHasGateway || objectHasGateway || gatewayModel
		|| stringField(device, "type").toUpperCase() === "GATEWAY";
}

async function getSites(settings: ThroughputSettings): Promise<Record<string, unknown>[]> {
	return getDataArray(await requestUniFi(settings, "/v1/sites"));
}

function getSiteUuid(site: Record<string, unknown>): string {
	const id = stringField(site, "id");
	if (isUuid(id)) return id;
	for (const [key, value] of Object.entries(site)) {
		if (typeof value === "string" && /(?:id|uuid)$/i.test(key) && isUuid(value)) return value;
	}
	return "";
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function getDataArray(response: unknown): Record<string, unknown>[] {
	if (Array.isArray(response)) return response.filter(isObject);
	if (isObject(response) && Array.isArray(response.data)) return response.data.filter(isObject);
	throw new Error("UniFi returned an unexpected response");
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function stringField(value: Record<string, unknown>, field: string): string {
	return typeof value[field] === "string" ? value[field] : "";
}

export function numberField(value: Record<string, unknown>, field: string): number {
	return typeof value[field] === "number" && Number.isFinite(value[field]) ? value[field] : 0;
}

function extractPublicIp(response: unknown): string {
	const wan = getWanHealth(response);
	const ip = stringField(wan, "wan_ip") || stringField(wan, "wanIp");
	if (ip) return ip;
	throw new Error("The WAN health response did not contain a public IP");
}

function getWanHealth(response: unknown): Record<string, unknown> {
	const wan = getDataArray(response).find((row) => stringField(row, "subsystem").toLowerCase() === "wan");
	if (!wan) throw new Error("The health response did not contain a WAN subsystem");
	return wan;
}

function extractWanIpv6(response: unknown): string {
	const device = getDataArray(response).find(isGatewayDevice);
	if (!device) return "";
	for (const path of [["wan1", "ipv6", 0], ["ipv6", 0]]) {
		const value = nestedValue(device, path);
		if (typeof value === "string" && value) return value.split("/")[0];
	}
	return "";
}

export function nestedValue(value: unknown, path: Array<string | number>): unknown {
	return path.reduce<unknown>((current, key) => {
		if (Array.isArray(current) && typeof key === "number") return current[key];
		if (isObject(current) && typeof key === "string") return current[key];
		return undefined;
	}, value);
}

function nestedNumber(value: unknown, path: Array<string | number>): number {
	const result = nestedValue(value, path);
	if (typeof result !== "number" || !Number.isFinite(result)) throw new Error(`Missing ${path.join(".")}`);
	return result;
}

export function extractNumber(response: unknown, candidates: string[]): number {
	const values = new Map<string, number>();
	walkNumbers(response, "", values);
	for (const candidate of candidates) {
		const match = [...values].find(([path]) => path.endsWith(candidate.toLowerCase()));
		if (match) return match[1];
	}
	throw new Error(`The response did not contain ${candidates[0]}`);
}

export function getUptimeDetails(seconds: number): { days: number; hours: number; minutes: number } {
	const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
	return {
		days: Math.floor(totalMinutes / 1_440),
		hours: Math.floor((totalMinutes % 1_440) / 60),
		minutes: totalMinutes % 60
	};
}

function formatUsage(value: number): string {
	if (value >= 100) return Math.round(value).toString();
	return value.toFixed(1);
}

export function normalizeIndex(value: number | undefined, length: number): number {
	const index = Number.isInteger(value) ? value! : 0;
	return ((index % length) + length) % length;
}

function copyToClipboard(value: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const command = process.platform === "win32" ? "clip.exe" : "pbcopy";
		const child = spawn(command, [], { stdio: ["pipe", "ignore", "ignore"] });
		child.once("error", reject);
		child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Clipboard command exited with ${code}`)));
		child.stdin.end(value);
	});
}

function getErrorDetail(body: string): string {
	try {
		const parsed: unknown = JSON.parse(body);
		if (isObject(parsed)) {
			for (const field of ["message", "detail", "error", "errorCode"]) {
				const value = parsed[field];
				if (typeof value === "string" && value.trim()) return value.trim().slice(0, 180);
			}
		}
	} catch {
		// Ignore HTML error pages; they are not useful in the property inspector.
	}
	return "";
}

/** Supports current Integration API names plus legacy UniFi byte-rate field names. */
function extractThroughput(value: unknown): Throughput {
	const values = new Map<string, number>();
	walkNumbers(value, "", values);

	const download = findRate(values, ["rxratebps", "rxrate"], ["wan.rxbytespersecond", "uplink.rxbytespersecond", "rxbytespersecond", "rxbytesr"]);
	const upload = findRate(values, ["txratebps", "txrate"], ["wan.txbytespersecond", "uplink.txbytespersecond", "txbytespersecond", "txbytesr"]);
	if (download === undefined || upload === undefined) {
		throw new Error("The statistics response did not contain RX/TX rates");
	}
	return { downloadBitsPerSecond: download, uploadBitsPerSecond: upload };
}

function walkNumbers(value: unknown, path: string, output: Map<string, number>): void {
	if (typeof value === "number" && Number.isFinite(value)) {
		output.set(path.replace(/[^a-z0-9]/gi, "").toLowerCase(), value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) walkNumbers(item, path, output);
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) walkNumbers(item, `${path}.${key}`, output);
	}
}

function findRate(values: Map<string, number>, bitCandidates: string[], byteCandidates: string[]): number | undefined {
	for (const candidate of bitCandidates) {
		const match = [...values].find(([path]) => path.endsWith(candidate));
		if (match) return Math.max(0, match[1]);
	}
	for (const candidate of byteCandidates) {
		const match = [...values].find(([path]) => path.endsWith(candidate));
		if (match) return Math.max(0, match[1] * 8);
	}
	return undefined;
}

function renderMetricSvg(label: string, value: string, history: number[], requestedColor?: string, requestedBackground?: string): string {
	const color = validColor(requestedColor);
	const background = validColor(requestedBackground, DEFAULT_BACKGROUND_COLOR);
	const graph = graphPaths(history);
	const labelSize = label.length >= 10 ? 15 : 22;
	const labelPath = centeredTextPath(label, labelSize, 72, 41);
	const ipLines = label.includes("IP") ? splitIpAddress(value) : undefined;
	const valueSize = value.length >= 13 ? 20 : value.length >= 10 ? 25 : value.length >= 7 ? 40 : value.length >= 5 ? 54 : 61;
	const valuePaths = ipLines
		? [centeredTextPath(ipLines[0], 27, 72, 76), centeredTextPath(ipLines[1], 27, 72, 105)]
		: [centeredTextPath(value, valueSize, 72, 93)];
	return `
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
	<defs>
	  <clipPath id="face"><rect x="10" y="10" width="124" height="124" rx="23"/></clipPath>
	</defs>
	<rect x="10" y="10" width="124" height="124" rx="23" fill="${background}" stroke="#4b4b4d" stroke-width="5"/>
	<g clip-path="url(#face)">
	  <path d="${graph.area}" fill="${color}" fill-opacity=".20"/>
	  <path d="${graph.line}" fill="none" stroke="${color}" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round"/>
	</g>
	<path d="${labelPath}" fill="#fff"/>
	${valuePaths.map((path) => `<path d="${path}" fill="#fff" stroke="#08080a" stroke-width="0.5" stroke-linejoin="round" paint-order="stroke"/>`).join("\n\t")}
</svg>`;
}

function renderThroughputSvg(throughput: Throughput, history: number[], requestedColor?: string, requestedBackground?: string): string {
	const downloadColor = validColor(requestedColor);
	const uploadColor = "#39b9ff";
	const background = validColor(requestedBackground, DEFAULT_BACKGROUND_COLOR);
	const graph = graphPaths(history);
	const heading = centeredTextPath("THROUGHPUT", 15, 72, 34);
	const download = centeredTextPath(formatMegabitsPerSecond(throughput.downloadBitsPerSecond), 33, 61, 76);
	const upload = centeredTextPath(formatMegabitsPerSecond(throughput.uploadBitsPerSecond), 33, 61, 111);
	const downUnit = centeredTextPath("Mb/s", 12, 109, 74);
	const upUnit = centeredTextPath("Mb/s", 12, 109, 109);
	return `
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
	<defs><clipPath id="face"><rect x="10" y="10" width="124" height="124" rx="23"/></clipPath></defs>
	<rect x="10" y="10" width="124" height="124" rx="23" fill="${background}" stroke="#4b4b4d" stroke-width="5"/>
	<g clip-path="url(#face)"><path d="${graph.area}" fill="${downloadColor}" fill-opacity=".16"/><path d="${graph.line}" fill="none" stroke="${downloadColor}" stroke-width="0.5"/></g>
	<path d="${heading}" fill="#fff"/>
	<g fill="${downloadColor}"><rect x="20" y="54" width="4" height="13" rx="2"/><path d="M15 64 L22 73 L29 64 Z"/></g>
	<g fill="${uploadColor}"><rect x="20" y="94" width="4" height="13" rx="2"/><path d="M15 97 L22 88 L29 97 Z"/></g>
	<path d="${download}" fill="#fff" stroke="#08080a" stroke-width="0.5" paint-order="stroke"/>
	<path d="${upload}" fill="#fff" stroke="#08080a" stroke-width="0.5" paint-order="stroke"/>
	<path d="${downUnit}" fill="${downloadColor}"/><path d="${upUnit}" fill="${uploadColor}"/>
</svg>`;
}

function renderMonthlyDataSvg(value: string, unit: "GB" | "TB", requestedColor?: string, requestedBackground?: string): string {
	const accent = validColor(requestedColor);
	const background = validColor(requestedBackground, DEFAULT_BACKGROUND_COLOR);
	const heading = centeredTextPath("WAN TOTAL", 16, 72, 42);
	const valueSize = value.length >= 6 ? 43 : value.length >= 5 ? 49 : 57;
	const valuePath = centeredTextPath(value, valueSize, 72, 91);
	const unitPath = centeredTextPath(unit, 19, 72, 117);
	return `
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
	<rect x="10" y="10" width="124" height="124" rx="23" fill="${background}" stroke="#4b4b4d" stroke-width="5"/>
	<path d="${heading}" fill="#fff"/>
	<path d="${valuePath}" fill="${accent}" stroke="#08080a" stroke-width="0.5" paint-order="stroke"/>
	<path d="${unitPath}" fill="${accent}"/>
</svg>`;
}

function renderGatewayUptimeSvg(details: { days: number; hours: number; minutes: number }, requestedColor?: string, requestedBackground?: string): string {
	const accent = validColor(requestedColor);
	const background = validColor(requestedBackground, DEFAULT_BACKGROUND_COLOR);
	const heading = centeredTextPath("GATEWAY UPTIME", 12, 72, 37);
	const days = details.days.toString();
	const valuePath = centeredTextPath(days, days.length >= 4 ? 43 : days.length >= 3 ? 50 : 58, 72, 82);
	const daysPath = centeredTextPath("DAYS", 16, 72, 105);
	const remainderPath = centeredTextPath(`${details.hours}h ${details.minutes}m`, 17, 72, 125);
	return `
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
	<rect x="10" y="10" width="124" height="124" rx="23" fill="${background}" stroke="#4b4b4d" stroke-width="5"/>
	<path d="${heading}" fill="#fff"/>
	<path d="${valuePath}" fill="${accent}" stroke="#08080a" stroke-width="0.5" paint-order="stroke"/>
	<path d="${daysPath}" fill="${accent}"/>
	<path d="${remainderPath}" fill="#fff"/>
</svg>`;
}

function renderNetworkStatusSvg(details: { ispName: string; online: boolean }, requestedBackground?: string): string {
	const background = validColor(requestedBackground, DEFAULT_BACKGROUND_COLOR);
	const statusColor = details.online ? "#12c892" : "#ff4057";
	const headingSize = details.ispName.length >= 14 ? 13 : details.ispName.length >= 10 ? 16 : 20;
	const heading = centeredTextPath(details.ispName, headingSize, 72, 42);
	const status = centeredTextPath(details.online ? "ONLINE" : "OFFLINE", 18, 72, 119);
	return `
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
	<rect x="10" y="10" width="124" height="124" rx="23" fill="${background}" stroke="#4b4b4d" stroke-width="5"/>
	<path d="${heading}" fill="#fff"/>
	<circle cx="72" cy="76" r="21" fill="${statusColor}"/>
	<path d="${status}" fill="${statusColor}"/>
</svg>`;
}

function splitIpAddress(value: string): [string, string] | undefined {
	const octets = value.split(".");
	if (octets.length === 4) return [`${octets[0]}.${octets[1]}.`, `${octets[2]}.${octets[3]}`];
	if (value.includes(":")) {
		const midpoint = Math.floor(value.length / 2);
		const splitAt = value.indexOf(":", midpoint);
		const index = splitAt > 0 ? splitAt + 1 : midpoint;
		return [value.slice(0, index), value.slice(index)];
	}
	return undefined;
}

function renderStatusSvg(top: string, bottom: string, requestedColor?: string, requestedBackground?: string): string {
	const color = validColor(requestedColor);
	const background = validColor(requestedBackground, DEFAULT_BACKGROUND_COLOR);
	const topPath = centeredTextPath(top, 22, 72, 63);
	const bottomPath = centeredTextPath(bottom, 22, 72, 91);
	return `
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
	<rect width="144" height="144" rx="18" fill="${background}"/>
	<path d="M0 119 C28 91 46 137 74 111 S116 80 144 101 L144 144 L0 144 Z" fill="${color}" fill-opacity=".72"/>
	<path d="${topPath}" fill="#f7f7f2" stroke="#11121d" stroke-width="2" paint-order="stroke"/>
	<path d="${bottomPath}" fill="#f7f7f2" stroke="#11121d" stroke-width="2" paint-order="stroke"/>
</svg>`;
}

function graphPaths(history: number[]): { area: string; line: string } {
	const samples = history.length > 1 ? history : [0, history[0] ?? 0];
	const max = Math.max(1, ...samples);
	const points = samples.map((value, index) => {
		const x = 10 + index * (124 / (samples.length - 1));
		const y = 119 - (Math.max(0, value) / max) * 48;
		return `${x.toFixed(1)} ${y.toFixed(1)}`;
	});
	const line = `M${points.join(" L")}`;
	return { line, area: `M10 119 L${points.join(" L")} L134 119 Z` };
}

function formatMegabitsPerSecond(bitsPerSecond: number): string {
	return Math.round(Math.max(0, bitsPerSecond) / 1_000_000).toString();
}

export function centeredTextPath(text: string, fontSize: number, centerX: number, baselineY: number): string {
	const initial = PLAY_BOLD.getPath(text, 0, baselineY, fontSize);
	const box = initial.getBoundingBox();
	const x = centerX - (box.x1 + box.x2) / 2;
	return PLAY_BOLD.getPath(text, x, baselineY, fontSize).toPathData(2);
}

export function validColor(color?: string, fallback = DEFAULT_GRAPH_COLOR): string {
	return color && /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

export async function setKeyImage(action: { setTitle(title: string): Promise<void>; setImage(image?: string): Promise<void> }, svg: string): Promise<void> {
	const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	await Promise.all([action.setTitle(""), action.setImage(image)]);
}
