// os.flisk.si: the FliskOS website. Everything is a static file in public/, served by Cloudflare without running
// this code; wrangler.toml sends only /download/* here, so the zip links always follow the latest GitHub release.
// Security headers: public/_headers covers the static files, security-headers.js covers what this Worker returns.
import { withSecurityHeaders } from "./security-headers.js";

const DOWNLOADS = {
	"/download/mac": "https://github.com/flisk-sh/fliskos/releases/latest/download/FliskOS-macOS.zip",
	"/download/windows": "https://github.com/flisk-sh/fliskos/releases/latest/download/FliskOS-windows.zip",
};

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		if (DOWNLOADS[pathname]) return withSecurityHeaders(Response.redirect(DOWNLOADS[pathname], 302));
		return withSecurityHeaders(await env.ASSETS.fetch(request));
	},
};
