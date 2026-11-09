// os.flisk.si: the FliskOS website. Everything is a static file in public/, served by Cloudflare without running
// this code; wrangler.toml sends only /download/* here, so the zip link always follows the latest GitHub release.
const MAC_ZIP = "https://github.com/flisk-sh/fliskos/releases/latest/download/FliskOS-macOS.zip";

export default {
	fetch(request, env) {
		const { pathname } = new URL(request.url);
		if (pathname === "/download/mac") return Response.redirect(MAC_ZIP, 302);
		return env.ASSETS.fetch(request);
	},
};
