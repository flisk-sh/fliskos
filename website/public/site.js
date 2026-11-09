// The Download button copies the install command and opens the steps under it. Without this script the button is a
// link to #mac-steps, which shows the same steps.
(() => {
	const copy = (text) => navigator.clipboard.writeText(text).then(() => true, () => false);

	const button = document.getElementById("dlb");
	const steps = document.getElementById("mac-steps");
	const status = document.getElementById("dlok");
	const command = document.getElementById("dlcmd");
	if (button && steps && status && command) {
		button.addEventListener("click", async (event) => {
			event.preventDefault();
			const copied = await copy(command.textContent.trim());
			if (!copied) getSelection().selectAllChildren(command);
			steps.classList.add("open");
			status.textContent = copied ? "Copied. Now:" : "Copy the command below, then:";
			if (copied) button.querySelector("b").textContent = "Copied ✓";
			steps.scrollIntoView({ behavior: "smooth", block: "nearest" });
		});
	}

	for (const copyButton of document.querySelectorAll("[data-copy]")) {
		copyButton.addEventListener("click", async () => {
			const copied = await copy(copyButton.dataset.copy);
			if (!copied) getSelection().selectAllChildren(copyButton.previousElementSibling);
			copyButton.textContent = copied ? "Copied ✓" : "Select";
			setTimeout(() => {
				copyButton.textContent = "Copy";
			}, 1800);
		});
	}

	// Tiles, screens and agent rows open that screen in the live demo.
	const frame = document.getElementById("demo-frame");
	document.addEventListener("click", (event) => {
		const target = event.target.closest("[data-demo]");
		if (!target || !frame) return;
		frame.contentWindow.postMessage({ fliskosDemo: target.dataset.demo, provider: target.dataset.provider }, location.origin);
		document.getElementById("demo").scrollIntoView({ block: "start" });
	});

	// The hero tiles lean toward the pointer.
	const hero = document.querySelector(".hero");
	if (hero && matchMedia("(min-width: 1120px) and (prefers-reduced-motion: no-preference)").matches) {
		hero.addEventListener("pointermove", (event) => {
			hero.style.setProperty("--px", ((event.clientX / innerWidth - 0.5) * 18).toFixed(1));
			hero.style.setProperty("--py", ((event.clientY / innerHeight - 0.5) * 18).toFixed(1));
		});
	}
})();
