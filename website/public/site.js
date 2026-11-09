// The Download button copies the install command and opens the steps under it. Without this script the button is a
// link to #mac-steps, which shows the same steps.
(() => {
	const button = document.getElementById("dlb");
	const steps = document.getElementById("mac-steps");
	const status = document.getElementById("dlok");
	const command = document.getElementById("dlcmd");
	if (button && steps && status && command) {
		const done = (copied) => {
			steps.classList.add("open");
			status.textContent = copied ? "Copied. Now:" : "Copy the command below, then:";
			button.querySelector("b").textContent = copied ? "Copied ✓" : "Download for macOS";
			steps.scrollIntoView({ behavior: "smooth", block: "nearest" });
		};
		button.addEventListener("click", async (event) => {
			event.preventDefault();
			try {
				await navigator.clipboard.writeText(command.textContent.trim());
				done(true);
			} catch {
				getSelection().selectAllChildren(command);
				done(false);
			}
		});
	}

	const video = document.querySelector("video");
	if (video && matchMedia("(prefers-reduced-motion: reduce)").matches) {
		video.removeAttribute("autoplay");
		video.pause();
		video.controls = true;
	}
})();
