import streamDeck, { action, DidReceiveSettingsEvent, KeyDownEvent, KeyUpEvent, SendToPluginEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import {
	centeredTextPath, DataSourceItem, DataSourceRequest, extractNumber, getDataArray, getSiteItems,
	getUptimeDetails, isObject, nestedValue, normalizeIndex, requestLegacy, requestUniFi, setKeyImage,
	stringField, ThroughputSettings, validColor
} from "./live-throughput";

const VIEWS = ["status", "performance", "network", "uptime"] as const;
const HOLD_MILLISECONDS = 700;
const DEFAULT_BACKGROUND = "#17172b";
const DEFAULT_ACCENT = "#20e3b2";

type DeviceMetricSettings = ThroughputSettings & {
	deviceId?: string;
	viewIndex?: number;
	showIp?: boolean;
};

type DeviceRecord = Record<string, unknown>;

@action({ UUID: "com.deadfrog-studios.ubiquitous.device-metrics" })
export class DeviceMetrics extends SingletonAction<DeviceMetricSettings> {
	readonly #timers = new Map<string, NodeJS.Timeout>();
	readonly #refreshing = new Set<string>();
	readonly #pressedAt = new Map<string, number>();
	readonly #dashboardUrls = new Map<string, string>();

	override async onWillAppear(ev: WillAppearEvent<DeviceMetricSettings>): Promise<void> {
		await this.#restart(ev.action.id, ev.payload.settings);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<DeviceMetricSettings>): Promise<void> {
		await this.#restart(ev.action.id, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<DeviceMetricSettings>): void {
		this.#stop(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<DeviceMetricSettings>): void {
		this.#pressedAt.set(ev.action.id, Date.now());
	}

	override async onKeyUp(ev: KeyUpEvent<DeviceMetricSettings>): Promise<void> {
		const heldFor = Date.now() - (this.#pressedAt.get(ev.action.id) ?? Date.now());
		this.#pressedAt.delete(ev.action.id);
		const settings = await ev.action.getSettings<DeviceMetricSettings>();
		if (heldFor >= HOLD_MILLISECONDS) {
			if (!settings.udmAddress || !settings.deviceId) return void await ev.action.showAlert();
			await streamDeck.system.openUrl(this.#dashboardUrls.get(ev.action.id) ?? deviceDashboardUrl(settings));
			return;
		}
		if (VIEWS[normalizeIndex(settings.viewIndex, VIEWS.length)] === "status") {
			settings.showIp = !settings.showIp;
			await ev.action.setSettings(settings);
			await this.#refresh(ev.action.id);
		}
	}

	override async onSendToPlugin(ev: SendToPluginEvent<DataSourceRequest, DeviceMetricSettings>): Promise<void> {
		if (ev.payload.event !== "getSites" && ev.payload.event !== "getDevices") return;
		try {
			const settings = await ev.action.getSettings<DeviceMetricSettings>();
			let items: DataSourceItem[];
			if (ev.payload.event === "getSites") {
				items = await getSiteItems(settings);
				if (items.length && !items.some(({ value }) => value === settings.siteId)) {
					settings.siteId = items[0].value;
					settings.deviceId = undefined;
					await ev.action.setSettings(settings);
				}
			} else {
				if (!settings.siteId?.trim()) {
					const sites = await getSiteItems(settings);
					if (!sites.length) throw new Error("No sites found");
					settings.siteId = sites[0].value;
					await ev.action.setSettings(settings);
				}
				items = await getDeviceItems(settings);
			}
			if (ev.payload.event === "getDevices" && items.length && !items.some(({ value }) => value === settings.deviceId)) {
				settings.deviceId = items[0].value;
				await ev.action.setSettings(settings);
			}
			await streamDeck.ui.sendToPropertyInspector({ event: ev.payload.event, items });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await streamDeck.ui.sendToPropertyInspector({
				event: ev.payload.event,
				items: [{ label: `Unable to load: ${message}`, value: "", disabled: true }]
			});
		}
	}

	async #restart(contextId: string, settings: DeviceMetricSettings): Promise<void> {
		this.#stop(contextId);
		await this.#refresh(contextId);
		const seconds = Math.max(1, Number(settings.pollIntervalSeconds) || 5);
		this.#timers.set(contextId, setInterval(() => void this.#refresh(contextId), seconds * 1000));
	}

	#stop(contextId: string): void {
		const timer = this.#timers.get(contextId);
		if (timer) clearInterval(timer);
		this.#timers.delete(contextId);
	}

	async #refresh(contextId: string): Promise<void> {
		if (this.#refreshing.has(contextId)) return;
		const key = this.actions.find(({ id }) => id === contextId);
		if (!key?.isKey()) return;
		this.#refreshing.add(contextId);
		try {
			const settings = await key.getSettings<DeviceMetricSettings>();
			if (!settings.udmAddress?.trim() || !settings.apiKey?.trim() || !settings.siteId?.trim() || !settings.deviceId?.trim()) {
				await setKeyImage(key, renderMessage("CONFIGURE", "DEVICE", settings.backgroundColor));
				return;
			}
			const [deviceResponse, statsResponse, legacyResponse] = await Promise.all([
				requestUniFi(settings, `/v1/sites/${encodeURIComponent(settings.siteId)}/devices/${encodeURIComponent(settings.deviceId)}`),
				requestUniFi(settings, `/v1/sites/${encodeURIComponent(settings.siteId)}/devices/${encodeURIComponent(settings.deviceId)}/statistics/latest`),
				requestLegacy(settings, "/stat/device").catch(() => undefined)
			]);
			const device = unwrapObject(deviceResponse);
			const stats = unwrapObject(statsResponse);
			const legacy = matchLegacyDevice(legacyResponse, device);
			this.#dashboardUrls.set(contextId, deviceDashboardUrl(settings, legacy));
			const view = VIEWS[normalizeIndex(settings.viewIndex, VIEWS.length)];
			await setKeyImage(key, renderDevice(view, device, stats, legacy, settings));
		} catch (error) {
			console.error(`Unable to update Device Metrics ${contextId}: ${error instanceof Error ? error.message : String(error)}`);
			await setKeyImage(key, renderMessage("DEVICE", "ERROR"));
			await key.showAlert();
		} finally {
			this.#refreshing.delete(contextId);
		}
	}
}

async function getDeviceItems(settings: DeviceMetricSettings): Promise<DataSourceItem[]> {
	if (!settings.siteId?.trim()) throw new Error("Select a site first");
	const devices = getDataArray(await requestUniFi(settings, `/v1/sites/${encodeURIComponent(settings.siteId)}/devices`));
	const items = devices.map((device) => {
		const name = stringField(device, "name") || stringField(device, "model") || "UniFi device";
		const type = deviceType(device);
		return { label: `${name} — ${type}`, value: stringField(device, "id") };
	}).filter(({ value }) => value);
	if (!items.length) throw new Error("No adopted devices found at this site");
	return items;
}

function unwrapObject(response: unknown): DeviceRecord {
	if (isObject(response) && isObject(response.data)) return response.data;
	if (isObject(response) && !Array.isArray(response.data)) return response;
	const rows = getDataArray(response);
	if (!rows.length) throw new Error("UniFi returned no device data");
	return rows[0];
}

function matchLegacyDevice(response: unknown, device: DeviceRecord): DeviceRecord | undefined {
	if (!response) return undefined;
	let devices: DeviceRecord[];
	try { devices = getDataArray(response); } catch { return undefined; }
	const mac = normalizeMac(stringField(device, "macAddress") || stringField(device, "mac"));
	const name = stringField(device, "name");
	return devices.find((candidate) => normalizeMac(stringField(candidate, "mac")) === mac && mac)
		?? devices.find((candidate) => stringField(candidate, "name") === name && name);
}

function renderDevice(view: typeof VIEWS[number], device: DeviceRecord, stats: DeviceRecord, legacy: DeviceRecord | undefined, settings: DeviceMetricSettings): string {
	const name = stringField(device, "name") || stringField(device, "model") || "DEVICE";
	const background = validColor(settings.backgroundColor, DEFAULT_BACKGROUND);
	const accent = validColor(settings.graphColor, DEFAULT_ACCENT);
	if (view === "status") {
		if (settings.showIp) {
			const ip = firstString(device, ["ipAddress", "ip"]) || (legacy ? firstString(legacy, ["ip", "lan_ip"]) : "") || "NO IP";
			return renderValueTile(name, "IP ADDRESS", ip, accent, background);
		}
		const online = deviceOnline(device, legacy);
		return renderStatusTile(name, deviceType(device), online, background);
	}
	if (view === "performance") {
		const cpu = optionalNumber([stats, legacy, device], ["cpuUtilizationPct", "cpuUtilization", "system-stats.cpu", "system_stats.cpu", "cpu"]);
		const memory = optionalNumber([stats, legacy, device], ["memoryUtilizationPct", "memoryUtilization", "system-stats.mem", "system_stats.mem", "mem"]);
		return renderPerformanceTile(name, cpu, memory, accent, background);
	}
	if (view === "network") {
		const type = deviceType(device);
		const isSwitch = type === "SWITCH";
		const value = isSwitch ? activePortCount(stats, legacy) : clientCount(stats, legacy);
		return renderValueTile(name, isSwitch ? "ACTIVE PORTS" : "CLIENTS", value === undefined ? "—" : String(value), accent, background);
	}
	const seconds = optionalNumber([stats, legacy, device], ["uptimeSec", "uptime"]);
	return renderUptimeTile(name, seconds ?? 0, accent, background);
}

function deviceType(device: DeviceRecord): string {
	const explicit = `${stringField(device, "type")} ${stringField(device, "category")}`.toLowerCase();
	const features = Array.isArray(device.features) ? device.features.map(String).join(" ").toLowerCase() : "";
	const model = `${stringField(device, "model")} ${stringField(device, "name")}`;
	if (/switch/.test(explicit + features) || /\bUSW\b/i.test(model)) return "SWITCH";
	if (/access.?point|wireless|wifi/.test(explicit + features) || /\bU(?:AP|6|7)\b/i.test(model)) return "ACCESS POINT";
	if (/gateway/.test(explicit + features) || /\b(?:UDM|UCG|UXG|USG)/i.test(model)) return "GATEWAY";
	return "UNIFI DEVICE";
}

function deviceOnline(device: DeviceRecord, legacy?: DeviceRecord): boolean {
	for (const record of [device, legacy]) {
		if (!record) continue;
		for (const field of ["status", "state", "connectionState"]) {
			const value = record[field];
			if (typeof value === "boolean") return value;
			if (typeof value === "number") return value === 1;
			if (typeof value === "string") return /^(?:online|connected|ok|1)$/i.test(value);
		}
	}
	return false;
}

function optionalNumber(records: Array<DeviceRecord | undefined>, candidates: string[]): number | undefined {
	for (const record of records) {
		if (!record) continue;
		for (const candidate of candidates) {
			const value = nestedValue(record, candidate.split("."));
			if (typeof value === "number" && Number.isFinite(value)) return value;
		}
		try { return extractNumber(record, candidates); } catch { /* Try the next response. */ }
	}
	return undefined;
}

function clientCount(stats: DeviceRecord, legacy?: DeviceRecord): number | undefined {
	return optionalNumber([stats, legacy], ["connectedClientCount", "clientCount", "num_sta", "user-num_sta"]);
}

function activePortCount(stats: DeviceRecord, legacy?: DeviceRecord): number | undefined {
	for (const record of [stats, legacy]) {
		if (!record) continue;
		for (const field of ["ports", "portTable", "port_table"]) {
			const ports = record[field];
			if (Array.isArray(ports)) return ports.filter((port) => isObject(port) && portUp(port)).length;
		}
	}
	return optionalNumber([stats, legacy], ["activePortCount", "upPortCount"]);
}

function portUp(port: DeviceRecord): boolean {
	if (typeof port.up === "boolean") return port.up;
	if (typeof port.up === "number") return port.up === 1;
	return /^(?:up|connected)$/i.test(firstString(port, ["state", "status"]));
}

function firstString(record: DeviceRecord, fields: string[]): string {
	for (const field of fields) {
		const value = record[field];
		if (typeof value === "string" && value) return value;
	}
	return "";
}

function normalizeMac(value: string): string { return value.replace(/[^a-f0-9]/gi, "").toLowerCase(); }

function deviceDashboardUrl(settings: DeviceMetricSettings, legacy?: DeviceRecord): string {
	const raw = settings.udmAddress!.trim();
	const base = raw.match(/^https?:\/\//i) ? raw : `https://${raw}`;
	const url = new URL(base);
	const legacyId = legacy ? firstString(legacy, ["_id", "mac"]) : "";
	url.pathname = legacyId
		? `/network/default/devices/properties/device/${encodeURIComponent(legacyId)}/general`
		: "/network/default/devices";
	url.search = "";
	url.hash = "";
	return url.toString();
}

function frame(background: string, contents: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect x="10" y="10" width="124" height="124" rx="23" fill="${background}" stroke="#4b4b4d" stroke-width="5"/>${contents}</svg>`;
}

function heading(name: string): string {
	const label = name.toUpperCase();
	return `<path d="${centeredTextPath(label, label.length > 15 ? 11 : label.length > 10 ? 14 : 17, 72, 34)}" fill="#fff"/>`;
}

function renderStatusTile(name: string, type: string, online: boolean, background: string): string {
	const color = online ? "#12c892" : "#ff4057";
	return frame(background, `${heading(name)}<path d="${centeredTextPath(type, type.length > 10 ? 12 : 15, 72, 52)}" fill="#fff"/><circle cx="72" cy="81" r="20" fill="${color}"/><path d="${centeredTextPath(online ? "ONLINE" : "OFFLINE", 17, 72, 119)}" fill="${color}"/>`);
}

function renderPerformanceTile(name: string, cpu: number | undefined, memory: number | undefined, accent: string, background: string): string {
	const cpuText = cpu === undefined ? "—" : `${Math.round(cpu)}%`;
	const memText = memory === undefined ? "—" : `${Math.round(memory)}%`;
	return frame(background, `${heading(name)}<path d="${centeredTextPath("CPU", 13, 35, 58)}" fill="#fff"/><path d="${centeredTextPath("MEM", 13, 105, 58)}" fill="#fff"/><path d="${centeredTextPath(cpuText, 29, 35, 91)}" fill="${accent}"/><path d="${centeredTextPath(memText, 29, 105, 91)}" fill="${accent}"/><path d="${centeredTextPath("PERFORMANCE", 13, 72, 119)}" fill="#fff"/>`);
}

function renderValueTile(name: string, label: string, value: string, accent: string, background: string): string {
	const isIp = value.includes(".") || value.includes(":");
	const size = isIp ? (value.length > 15 ? 13 : 18) : value.length > 5 ? 39 : 57;
	return frame(background, `${heading(name)}<path d="${centeredTextPath(label, 14, 72, 55)}" fill="#fff"/><path d="${centeredTextPath(value, size, 72, 100)}" fill="${accent}" stroke="#08080a" stroke-width="0.5" paint-order="stroke"/>`);
}

function renderUptimeTile(name: string, seconds: number, accent: string, background: string): string {
	const value = getUptimeDetails(seconds);
	return frame(background, `${heading(name)}<path d="${centeredTextPath(String(value.days), 52, 72, 82)}" fill="${accent}"/><path d="${centeredTextPath("DAYS", 15, 72, 104)}" fill="${accent}"/><path d="${centeredTextPath(`${value.hours}h ${value.minutes}m`, 16, 72, 124)}" fill="#fff"/>`);
}

function renderMessage(top: string, bottom: string, requestedBackground?: string): string {
	const background = validColor(requestedBackground, DEFAULT_BACKGROUND);
	return frame(background, `<path d="${centeredTextPath(top, 20, 72, 67)}" fill="#fff"/><path d="${centeredTextPath(bottom, 20, 72, 94)}" fill="#fff"/>`);
}
