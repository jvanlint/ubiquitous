window.addEventListener("DOMContentLoaded", async () => {
	const buttons = document.querySelectorAll(".tab-button");
	const panels = document.querySelectorAll(".tab-panel");
	for (const button of buttons) {
		button.addEventListener("click", () => {
			for (const candidate of buttons) candidate.classList.toggle("active", candidate === button);
			for (const panel of panels) panel.hidden = panel.id !== button.dataset.tab;
			if (button.dataset.tab === "action-tab") {
				window.dispatchEvent(new CustomEvent("unifi-action-tab-shown"));
			}
		});
	}

	const address = document.querySelector("#global-udm-address");
	const apiKey = document.querySelector("#global-api-key");
	const certificate = document.querySelector("#global-allow-self-signed");
	if (!address || !apiKey || !certificate) return;

	const client = SDPIComponents.streamDeckClient;
	let globalSettings = await client.getGlobalSettings();
	const actionSettings = await client.getSettings();

	// Migrate credentials saved by older versions on the selected action.
	const migrated = {
		...globalSettings,
		udmAddress: globalSettings.udmAddress || actionSettings.udmAddress || "",
		apiKey: globalSettings.apiKey || actionSettings.apiKey || "",
		allowSelfSignedCertificate: globalSettings.allowSelfSignedCertificate
			?? actionSettings.allowSelfSignedCertificate
			?? true
	};
	if (JSON.stringify(migrated) !== JSON.stringify(globalSettings)) {
		await client.setGlobalSettings(migrated);
		globalSettings = migrated;
	}

	address.value = globalSettings.udmAddress || "";
	apiKey.value = globalSettings.apiKey || "";
	certificate.checked = globalSettings.allowSelfSignedCertificate !== false;

	let timer;
	const save = () => {
		clearTimeout(timer);
		timer = setTimeout(async () => {
			globalSettings = {
				...globalSettings,
				udmAddress: address.value.trim(),
				apiKey: apiKey.value.trim(),
				allowSelfSignedCertificate: certificate.checked
			};
			await client.setGlobalSettings(globalSettings);
			window.dispatchEvent(new CustomEvent("unifi-global-settings-change"));
		}, 300);
	};

	address.addEventListener("input", save);
	apiKey.addEventListener("input", save);
	certificate.addEventListener("change", save);
});
