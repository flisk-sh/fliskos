// os.flisk.si: the FliskOS website. Everything is a static file in public/, served by Cloudflare without running
// this code; wrangler.toml sends only /download/* here, so the zip links always follow the latest GitHub release.
const DOWNLOADS = {
	"/download/mac": "https://github.com/flisk-sh/fliskos/releases/latest/download/FliskOS-macOS.zip",
	"/download/windows": "https://github.com/flisk-sh/fliskos/releases/latest/download/FliskOS-windows.zip",
};

export default {
	fetch(request, env) {
		const { pathname } = new URL(request.url);
		if (DOWNLOADS[pathname]) return Response.redirect(DOWNLOADS[pathname], 302);
		return env.ASSETS.fetch(request);
	},
};
