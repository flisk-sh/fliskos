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
})();
