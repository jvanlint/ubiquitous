import streamDeck, { action, DidReceiveSettingsEvent, KeyDownEvent, KeyUpEvent, SendToPluginEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { requestLegacy, requestUniFi, withGlobalUniFiSettings, withoutGlobalUniFiSettings } from "../common/unifi-api";
import { networkStatsIcon } from "../common/svg-icons";
import {
	centeredTextPath, DataSourceItem, DataSourceRequest, extractNumber, getDataArray, getSiteItems,
	getUptimeDetails, isObject, nestedValue, normalizeIndex, setKeyImage,
	stringField, ThroughputSettings, validColor
} from "./live-throughput";

const VIEWS = ["performance", "network", "uptime"] as const;
const VIEW_LAYOUT_VERSION = 2;
const HOLD_MILLISECONDS = 700;
const DEFAULT_BACKGROUND = "#000000";
const DEVICE_HEADER = "#0063e8";

type DeviceMetricSettings = ThroughputSettings & {
	deviceId?: string;
	viewIndex?: number;
	showIp?: boolean;
	viewLayoutVersion?: number;
};

type DeviceRecord = Record<string, unknown>;

async function migrateViewSettings(action: WillAppearEvent<DeviceMetricSettings>["action"], incoming: DeviceMetricSettings): Promise<DeviceMetricSettings> {
	if (incoming.viewLayoutVersion === VIEW_LAYOUT_VERSION) return incoming;
	const oldIndex = normalizeIndex(incoming.viewIndex, 4);
	const settings = {
		...incoming,
		viewIndex: oldIndex <= 1 ? 0 : oldIndex - 1,
		viewLayoutVersion: VIEW_LAYOUT_VERSION
	};
	await action.setSettings(withoutGlobalUniFiSettings(settings));
	return settings;
}

@action({ UUID: "com.deadfrog-studios.ubiquitous.device-metrics" })
export class DeviceMetrics extends SingletonAction<DeviceMetricSettings> {
	readonly #timers = new Map<string, NodeJS.Timeout>();
	readonly #refreshing = new Set<string>();
	readonly #pressedAt = new Map<string, number>();
	readonly #dashboardUrls = new Map<string, string>();

	override async onWillAppear(ev: WillAppearEvent<DeviceMetricSettings>): Promise<void> {
		const settings = await migrateViewSettings(ev.action, ev.payload.settings);
		await this.#restart(ev.action.id, settings);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<DeviceMetricSettings>): Promise<void> {
		const settings = await migrateViewSettings(ev.action, ev.payload.settings);
		await this.#restart(ev.action.id, settings);
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
		const settings = await withGlobalUniFiSettings(await ev.action.getSettings<DeviceMetricSettings>());
		if (heldFor >= HOLD_MILLISECONDS) {
			if (!settings.udmAddress || !settings.deviceId) return void await ev.action.showAlert();
			await streamDeck.system.openUrl(this.#dashboardUrls.get(ev.action.id) ?? deviceDashboardUrl(settings));
			return;
		}
	}

	override async onSendToPlugin(ev: SendToPluginEvent<DataSourceRequest, DeviceMetricSettings>): Promise<void> {
		if (ev.payload.event !== "getSites" && ev.payload.event !== "getDevices") return;
		try {
			const settings = await withGlobalUniFiSettings(await ev.action.getSettings<DeviceMetricSettings>());
			let items: DataSourceItem[];
			if (ev.payload.event === "getSites") {
				items = await getSiteItems(settings);
				if (items.length && !items.some(({ value }) => value === settings.siteId)) {
					settings.siteId = items[0].value;
					settings.deviceId = undefined;
					await ev.action.setSettings(withoutGlobalUniFiSettings(settings));
				}
			} else {
				if (!settings.siteId?.trim()) {
					const sites = await getSiteItems(settings);
					if (!sites.length) throw new Error("No sites found");
					settings.siteId = sites[0].value;
					await ev.action.setSettings(withoutGlobalUniFiSettings(settings));
				}
				items = await getDeviceItems(settings);
			}
			if (ev.payload.event === "getDevices" && items.length && !items.some(({ value }) => value === settings.deviceId)) {
				settings.deviceId = items[0].value;
				await ev.action.setSettings(withoutGlobalUniFiSettings(settings));
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
			const settings = await withGlobalUniFiSettings(await key.getSettings<DeviceMetricSettings>());
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
	if (view === "performance") {
		const cpu = optionalNumber([stats, legacy, device], ["cpuUtilizationPct", "cpuUtilization", "system-stats.cpu", "system_stats.cpu", "cpu"]);
		const memory = optionalNumber([stats, legacy, device], ["memoryUtilizationPct", "memoryUtilization", "system-stats.mem", "system_stats.mem", "mem"]);
		return renderPerformanceTile(name, cpu, memory, deviceOnline(device, legacy), background);
	}
	if (view === "network") {
		const type = deviceType(device);
		const isSwitch = type === "SWITCH";
		const value = isSwitch ? activePortCount(stats, legacy) : clientCount(stats, legacy);
		return renderValueTile(name, isSwitch ? "ACTIVE PORTS" : "CLIENTS", value === undefined ? "—" : String(value), background);
	}
	const seconds = optionalNumber([stats, legacy, device], ["uptimeSec", "uptime"]);
	return renderUptimeTile(name, seconds ?? 0, background);
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
	const path = centeredTextPath(label, label.length > 15 ? 11 : label.length > 10 ? 14 : 16, 72, 26);
	return `<rect width="144" height="35" fill="${DEVICE_HEADER}"/><path d="${path}" fill="#fff"/>`;
}

function renderPerformanceTile(name: string, cpu: number | undefined, memory: number | undefined, online: boolean, background: string): string {
	const cpuText = cpu === undefined ? "—" : String(Math.round(cpu));
	const memoryText = memory === undefined ? "—" : String(Math.round(memory));
	const cpuColor = utilizationColor(cpu, 70, 85);
	const memoryColor = utilizationColor(memory, 75, 90);
	const cpuSize = cpuText.length > 2 ? 31 : 38;
	const memorySize = memoryText.length > 2 ? 31 : 38;
	const contents = [
		heading(name),
		networkStatsIcon("cpu", "#fff", 18, 50, 28, 26),
		`<path d="${centeredTextPath(cpuText, cpuSize, 75, 74)}" fill="${cpuColor}"/>`,
		cpu === undefined ? "" : `<path d="${centeredTextPath("%", 22, 106, 61)}" fill="${cpuColor}"/>`,
		networkStatsIcon("ram", "#fff", 18, 91, 28, 26),
		`<path d="${centeredTextPath(memoryText, memorySize, 75, 115)}" fill="${memoryColor}"/>`,
		memory === undefined ? "" : `<path d="${centeredTextPath("%", 22, 106, 102)}" fill="${memoryColor}"/>`,
		`<circle cx="122.5" cy="124.5" r="8" fill="${online ? "#2fff00" : "#ff4057"}" stroke="#fff"/>`
	].join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="${background}"/>${contents}</svg>`;
}

function utilizationColor(value: number | undefined, amberAt: number, redAt: number): string {
	if (value === undefined) return "#fff";
	if (value >= redAt) return "#ff4057";
	if (value >= amberAt) return "#ff7b00";
	return "#2fff00";
}

function renderValueTile(name: string, label: string, value: string, background: string): string {
	const isIp = value.includes(".") || value.includes(":");
	const size = isIp ? (value.length > 15 ? 13 : 18) : value.length > 5 ? 39 : 51;
	const labelSize = label.length > 9 ? 17 : 24;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="${background}"/>${heading(name)}<path d="${centeredTextPath(value, size, 72, 88)}" fill="${DEVICE_HEADER}"/><path d="${centeredTextPath(label, labelSize, 72, 126)}" fill="#fff"/></svg>`;
}

function renderUptimeTile(name: string, seconds: number, background: string): string {
	const value = getUptimeDetails(seconds);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="${background}"/>${heading(name)}<path d="${centeredTextPath(String(value.days), 52, 72, 88)}" fill="${DEVICE_HEADER}"/><path d="${centeredTextPath("DAYS", 15, 72, 103)}" fill="#88bbff"/><path d="${centeredTextPath(`${value.hours}h ${value.minutes}m`, 24, 72, 128)}" fill="#fff"/></svg>`;
}

function renderMessage(top: string, bottom: string, requestedBackground?: string): string {
	const background = validColor(requestedBackground, DEFAULT_BACKGROUND);
	return frame(background, `<path d="${centeredTextPath(top, 20, 72, 67)}" fill="#fff"/><path d="${centeredTextPath(bottom, 20, 72, 94)}" fill="#fff"/>`);
}
