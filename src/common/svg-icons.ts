import { readFileSync } from "node:fs";

export type NetworkStatsIcon = "cpu" | "ram" | "upload" | "download";

const ICON_FILES: Record<NetworkStatsIcon, string> = {
	cpu: "cpu-chip-svgrepo-com.svg",
	ram: "ram-memory-svgrepo-com.svg",
	upload: "up-square-svgrepo-com.svg",
	download: "down-square-svgrepo-com.svg"
};

const sources = new Map<NetworkStatsIcon, string>();
const encoded = new Map<string, string>();

/** Embeds one of the canonical Network Stats SVG assets in a generated key image. */
export function networkStatsIcon(name: NetworkStatsIcon, color: string, x: number, y: number, width: number, height: number): string {
	const cacheKey = `${name}:${color}`;
	let dataUri = encoded.get(cacheKey);
	if (!dataUri) {
		let source = sources.get(name);
		if (!source) {
			source = readFileSync(new URL(`../imgs/actions/network_stats/${ICON_FILES[name]}`, import.meta.url), "utf8")
				.replace(/<\?xml[\s\S]*?\?>/gi, "")
				.replace(/<!DOCTYPE[\s\S]*?>/gi, "")
				.replace(/<!--([\s\S]*?)-->/g, "");
			sources.set(name, source);
		}
		const colored = source
			.replace(/#000000/gi, color)
			.replace(/#231f20/gi, color);
		dataUri = `data:image/svg+xml;base64,${Buffer.from(colored).toString("base64")}`;
		encoded.set(cacheKey, dataUri);
	}
	return `<image x="${x}" y="${y}" width="${width}" height="${height}" href="${dataUri}"/>`;
}
