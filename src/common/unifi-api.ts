import { request } from "node:https";
import streamDeck from "@elgato/streamdeck";

export type UniFiApiSettings = {
	udmAddress?: string;
	apiKey?: string;
	allowSelfSignedCertificate?: boolean;
};

/** Adds the plugin-wide connection settings to an action's local settings. */
export async function withGlobalUniFiSettings<T extends UniFiApiSettings>(settings: T): Promise<T> {
	const globalSettings = await streamDeck.settings.getGlobalSettings<UniFiApiSettings>();
	return {
		...settings,
		udmAddress: globalSettings.udmAddress?.trim() || settings.udmAddress,
		apiKey: globalSettings.apiKey?.trim() || settings.apiKey,
		allowSelfSignedCertificate: globalSettings.allowSelfSignedCertificate
			?? settings.allowSelfSignedCertificate
	};
}

/** Removes plugin-wide connection values before persisting action settings. */
export function withoutGlobalUniFiSettings<T extends UniFiApiSettings>(settings: T): Omit<T, keyof UniFiApiSettings> {
	const actionSettings = { ...settings };
	delete actionSettings.udmAddress;
	delete actionSettings.apiKey;
	delete actionSettings.allowSelfSignedCertificate;
	return actionSettings;
}

export function requestUniFi(settings: UniFiApiSettings, integrationPath: string): Promise<unknown> {
	return requestUdm(settings, `/proxy/network/integration${integrationPath}`);
}

export function requestLegacy(settings: UniFiApiSettings, path: string, method = "GET", payload?: object): Promise<unknown> {
	return requestUdm(settings, `/proxy/network/api/s/default${path}`, method, payload);
}

function requestUdm(settings: UniFiApiSettings, apiPath: string, method = "GET", payload?: object): Promise<unknown> {
	if (!settings.udmAddress?.trim() || !settings.apiKey?.trim()) {
		return Promise.reject(new Error("Enter the UDM address and API key first"));
	}
	const baseUrl = settings.udmAddress.trim().match(/^https?:\/\//i)
		? settings.udmAddress.trim()
		: `https://${settings.udmAddress.trim()}`;
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
			let responseBody = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				responseBody += chunk;
				if (responseBody.length > 2_000_000) req.destroy(new Error("UniFi response was too large"));
			});
			res.on("end", () => {
				if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
					const detail = getErrorDetail(responseBody);
					reject(new Error(`UniFi returned HTTP ${res.statusCode ?? "unknown"}${detail ? `: ${detail}` : ""}`));
					return;
				}
				try { resolve(JSON.parse(responseBody)); } catch { reject(new Error("UniFi returned invalid JSON")); }
			});
		});
		req.on("timeout", () => req.destroy(new Error("UniFi request timed out")));
		req.on("error", reject);
		req.end(body);
	});
}

function getErrorDetail(body: string): string {
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed && typeof parsed === "object") {
			const record = parsed as Record<string, unknown>;
			for (const field of ["message", "detail", "error", "errorCode"]) {
				const value = record[field];
				if (typeof value === "string" && value.trim()) return value.trim().slice(0, 180);
			}
		}
	} catch {
		// Ignore HTML error pages; they are not useful in the property inspector.
	}
	return "";
}
