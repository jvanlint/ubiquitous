import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { parse as parseFont } from "opentype.js";
import streamDeck, { action, DidReceiveSettingsEvent, KeyDownEvent, KeyUpEvent, SendToPluginEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { requestLegacy, requestUniFi, UniFiApiSettings, withGlobalUniFiSettings, withoutGlobalUniFiSettings } from "../common/unifi-api";
import { networkStatsIcon } from "../common/svg-icons";

const DEFAULT_POLL_SECONDS = 5;
const MIN_POLL_SECONDS = 1;
const DEFAULT_GRAPH_COLOR = "#20e3b2";
const DEFAULT_BACKGROUND_COLOR = "#17172b";
const HISTORY_LENGTH = 32;
const HOLD_MILLISECONDS = 700;
const VIEWS = ["throughput", "monthly_usage", "ip", "uptime", "isp_uptime", "latency", "status"] as const;
const fontFile = readFileSync(new URL("../fonts/Play-Bold.ttf", import.meta.url));
const PLAY_BOLD = parseFont(fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength));

export type ThroughputSettings = UniFiApiSettings & {
	siteId?: string;
	gatewayDeviceId?: string;
	pollIntervalSeconds?: number;
	graphColor?: string;
	monthlyUsageColor?: string;
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
			const settings = await withGlobalUniFiSettings(await ev.action.getSettings<ThroughputSettings>());
			const items = event === "getSites"
				? await getSiteItems(settings)
				: await getGatewayItems(settings, async (siteId) => {
					settings.siteId = siteId;
					settings.gatewayDeviceId = undefined;
					await ev.action.setSettings(withoutGlobalUniFiSettings(settings));
				});
			if (event === "getGateways" && items.length > 0
				&& !items.some((item) => item.value === settings.gatewayDeviceId)) {
				// sdpi-select displays its first data-source item when there is no
				// persisted value, but that visual default is not saved automatically.
				settings.gatewayDeviceId = items[0].value;
				await ev.action.setSettings(withoutGlobalUniFiSettings(settings));
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
			const settings = await withGlobalUniFiSettings(await action.getSettings<ThroughputSettings>());
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
					? renderMonthlyDataSvg(display.value, display.unit, settings.monthlyUsageColor, settings.backgroundColor)
					: display.uptimeDetails
						? renderGatewayUptimeSvg(display.uptimeDetails, settings.graphColor, settings.backgroundColor)
						: display.statusDetails
							? renderNetworkStatusSvg(display.statusDetails, settings.backgroundColor)
							: metric === "ip" && display.label === "WAN IP"
								? renderWanIpSvg(display.value, settings.backgroundColor)
								: metric === "isp_uptime"
								? renderIspUptimeSvg(display.value, display.accentColor, settings.backgroundColor)
									: metric === "latency"
										? renderLatencySvg(display.value, display.accentColor, settings.backgroundColor)
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
		return { label: "WAN UPTIME", value: `${Math.round(availability)}%`, accentColor: availability >= 99 ? "#2fff00" : availability >= 95 ? "#ffd23f" : "#ff4057" };
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
	if (!settings.siteId?.trim()) {
		const sites = await getSites(settings);
		const siteIds = sites.map(getSiteUuid).filter(Boolean);
		if (siteIds.length === 0) throw new Error("No sites found");
		settings.siteId = siteIds[0];
		await repairSiteId(settings.siteId);
	}
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
	void history;
	void requestedColor;
	const downloadColor = "#8d1af1";
	const uploadColor = "#1a69f1";
	const background = validColor(requestedBackground, "#1d1d1d");
	const downloadRate = formatThroughputRate(throughput.downloadBitsPerSecond);
	const uploadRate = formatThroughputRate(throughput.uploadBitsPerSecond);
	const downloadUnitColor = throughputUnitColor(downloadRate.unit);
	const uploadUnitColor = throughputUnitColor(uploadRate.unit);
	const heading = centeredTextPath("THROUGHPUT", 16, 72, 28);
	const download = fittedLeftTextPath(downloadRate.value, 38, 54, 68, 78);
	const upload = fittedLeftTextPath(uploadRate.value, 38, 54, 119, 78);
	const downloadUnit = centeredTextPath(downloadRate.unit, 16, 72, 83);
	const uploadUnit = centeredTextPath(uploadRate.unit, 16, 72, 133);
	return `
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
	<rect width="144" height="144" fill="${background}"/>
	<path d="${heading}" fill="#fff"/>
	${networkStatsIcon("download", downloadColor, 17.667, 42.667, 26.666, 26.666)}
	${networkStatsIcon("upload", uploadColor, 17.667, 93.667, 26.666, 26.666)}
	<path d="${download}" fill="#fff"/>
	<path d="${upload}" fill="#fff"/>
	<path d="${downloadUnit}" fill="${downloadUnitColor}"/>
	<path d="${uploadUnit}" fill="${uploadUnitColor}"/>
</svg>`;
}

function formatThroughputRate(bitsPerSecond: number): { value: string; unit: "Mbps" | "Kbps" } {
	const rate = Math.max(0, bitsPerSecond);
	return rate >= 1_000_000
		? { value: Math.round(rate / 1_000_000).toString(), unit: "Mbps" }
		: { value: Math.round(rate / 1_000).toString(), unit: "Kbps" };
}

function throughputUnitColor(unit: "Mbps" | "Kbps"): string {
	return unit === "Mbps" ? "#7fff00" : "#c56200";
}

function fittedLeftTextPath(text: string, maximumFontSize: number, x: number, baselineY: number, maximumWidth: number): string {
	const initial = PLAY_BOLD.getPath(text, x, baselineY, maximumFontSize);
	const box = initial.getBoundingBox();
	const width = box.x2 - box.x1;
	const fontSize = width > maximumWidth ? maximumFontSize * maximumWidth / width : maximumFontSize;
	return PLAY_BOLD.getPath(text, x, baselineY, fontSize).toPathData(2);
}

function renderWanIpSvg(value: string, requestedBackground?: string): string {
	const background = validColor(requestedBackground, "#000000");
	const accent = "#ff00e1";
	const heading = centeredTextPath("WAN IP", 16, 72, 28);
	const lines = splitIpAddress(value) ?? [value, ""];
	const firstLine = fittedCenteredTextPath(lines[0], 30, 72, 69, 116);
	const secondLine = fittedCenteredTextPath(lines[1], 30, 72, 101, 116);
	return `
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
	<rect width="144" height="144" fill="${background}"/>
	<path d="${heading}" fill="#fff"/>
	<path d="${firstLine}" fill="${accent}"/>
	${lines[1] ? `<path d="${secondLine}" fill="${accent}"/>` : ""}
</svg>`;
}

function renderMonthlyDataSvg(value: string, unit: "GB" | "TB", requestedColor?: string, requestedBackground?: string): string {
	const accent = validColor(requestedColor, "#c300ff");
	const background = validColor(requestedBackground, "#1d1d1d");
	const heading = centeredTextPath("WAN TOTAL", 16, 72, 28);
	const valuePath = fittedCenteredTextPath(value, 60, 72, 89, 106);
	const unitPath = centeredTextPath(unit, 24, 72, 119);
	return `
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
	<rect width="144" height="144" fill="${background}"/>
	<path d="${heading}" fill="#fff"/>
	<path d="${valuePath}" fill="${accent}"/>
	<path d="${unitPath}" fill="#fff"/>
</svg>`;
}

function renderGatewayUptimeSvg(details: { days: number; hours: number; minutes: number }, requestedColor?: string, requestedBackground?: string): string {
	void requestedColor;
	const accent = "#ff00e1";
	const background = validColor(requestedBackground, "#000000");
	const gatewayHeading = centeredTextPath("GATEWAY", 16, 72, 26);
	const uptimeHeading = centeredTextPath("UPTIME", 16, 72, 45);
	const days = details.days.toString();
	const valuePath = fittedCenteredTextPath(days, 55, 72, 91, 90);
	const daysPath = centeredTextPath("DAYS", 16, 72, 106);
	const remainderPath = fittedCenteredTextPath(`${details.hours}h ${details.minutes}m`, 24, 72, 132, 100);
	return `
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
	<rect width="144" height="144" fill="${background}"/>
	<path d="${gatewayHeading}" fill="#fff"/>
	<path d="${uptimeHeading}" fill="#fff"/>
	<path d="${valuePath}" fill="${accent}"/>
	<path d="${daysPath}" fill="${accent}"/>
	<path d="${remainderPath}" fill="#fff"/>
</svg>`;
}

function renderNetworkStatusSvg(details: { ispName: string; online: boolean }, requestedBackground?: string): string {
	const background = validColor(requestedBackground, "#333333");
	const statusColor = details.online ? "#09ff00" : "#ff4057";
	const heading = fittedCenteredTextPath(details.ispName.toUpperCase(), 16, 72, 28, 108);
	const status = centeredTextPath(details.online ? "ONLINE" : "OFFLINE", 18, 72, 126);
	return `
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
	<rect width="144" height="144" fill="${background}"/>
	<path d="${heading}" fill="#fff"/>
	<g fill="none" stroke="${statusColor}" stroke-width="3.37">
		<rect x="44.485" y="44.685" width="56.03" height="19.099" rx="4.54"/>
		<rect x="44.485" y="71.648" width="56.03" height="19.099" rx="4.54"/>
		<path d="M72.5 91v15.8M53 109.283h39" stroke-width="4.494"/>
	</g>
	<rect x="52.84" y="50.862" width="5.898" height="6.741" fill="${statusColor}"/>
	<rect x="52.84" y="77.825" width="5.898" height="6.741" fill="${statusColor}"/>
	<circle cx="72.5" cy="109.283" r="4.6" fill="${statusColor}"/>
	<path d="${status}" fill="${statusColor}" stroke="${background}" stroke-width="0.4" paint-order="stroke"/>
</svg>`;
}

function renderIspUptimeSvg(value: string, requestedColor?: string, requestedBackground?: string): string {
	const color = validColor(requestedColor, "#2fff00");
	const background = validColor(requestedBackground, "#000000");
	const heading = centeredTextPath("WAN UPTIME", 16, 72, 28);
	const percentage = superscriptPercentagePaths(value.replace("%", ""));
	return `
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
	<rect width="144" height="144" fill="${background}"/>
	<path d="${heading}" fill="#fff"/>
	<path d="${percentage.value}" fill="${color}" stroke="#000" stroke-width="1" stroke-linejoin="round" paint-order="stroke"/>
	<path d="${percentage.symbol}" fill="${color}" stroke="#000" stroke-width="1" stroke-linejoin="round" paint-order="stroke"/>
</svg>`;
}

function superscriptPercentagePaths(value: string): { value: string; symbol: string } {
	const valueSize = 48;
	const symbolSize = 28.8;
	const gap = 3.5;
	const initialValue = PLAY_BOLD.getPath(value, 0, 89, valueSize);
	const initialSymbol = PLAY_BOLD.getPath("%", 0, 73, symbolSize);
	const valueBox = initialValue.getBoundingBox();
	const symbolBox = initialSymbol.getBoundingBox();
	const valueWidth = valueBox.x2 - valueBox.x1;
	const symbolWidth = symbolBox.x2 - symbolBox.x1;
	const left = 72 - (valueWidth + gap + symbolWidth) / 2;
	const valueX = left - valueBox.x1;
	const symbolX = left + valueWidth + gap - symbolBox.x1;
	return {
		value: PLAY_BOLD.getPath(value, valueX, 89, valueSize).toPathData(2),
		symbol: PLAY_BOLD.getPath("%", symbolX, 73, symbolSize).toPathData(2)
	};
}

function renderLatencySvg(value: string, requestedColor?: string, requestedBackground?: string): string {
	const color = validColor(requestedColor, "#2fff00");
	const background = validColor(requestedBackground, "#000000");
	const heading = centeredTextPath("LATENCY", 16, 72, 28);
	const valuePath = fittedCenteredTextPath(`${value}ms`, 48, 72, 89, 92);
	return `
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
	<rect width="144" height="144" fill="${background}"/>
	<path d="${heading}" fill="#fff"/>
	<path d="${valuePath}" fill="${color}" stroke="#000" stroke-width="1" stroke-linejoin="round" paint-order="stroke"/>
</svg>`;
}

function fittedCenteredTextPath(text: string, maximumFontSize: number, centerX: number, baselineY: number, maximumWidth: number): string {
	const initial = PLAY_BOLD.getPath(text, 0, baselineY, maximumFontSize);
	const box = initial.getBoundingBox();
	const width = box.x2 - box.x1;
	const fontSize = width > maximumWidth ? maximumFontSize * maximumWidth / width : maximumFontSize;
	return centeredTextPath(text, fontSize, centerX, baselineY);
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
