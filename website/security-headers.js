// Baseline security headers for the responses this Worker builds itself (the /download/* redirects and anything it
// passes through from the assets binding). Files served straight from public/ get the same headers from public/_headers;
// keep the two lists in step (test/website.test.js checks both).
export const BASELINE = {
	"x-content-type-options": "nosniff",
	"x-frame-options": "SAMEORIGIN",
	"strict-transport-security": "max-age=31536000; includeSubDomains",
	"referrer-policy": "strict-origin-when-cross-origin",
	"permissions-policy": "camera=(), microphone=(), geolocation=()",
};

// Adds what is missing and never duplicates or overwrites a header that is already set. A CSP the response already has
// is kept; one without frame-ancestors gets frame-ancestors 'self', and a response with none gets only that directive.
export function withSecurityHeaders(response) {
	// Response.redirect() and fetched responses have immutable headers, so copy into a new Response.
	const out = new Response(response.body, response);
	for (const [name, value] of Object.entries(BASELINE)) {
		if (!out.headers.has(name)) out.headers.set(name, value);
	}
	const csp = out.headers.get("content-security-policy");
	if (csp === null) out.headers.set("content-security-policy", "frame-ancestors 'self'");
	else if (!/frame-ancestors/i.test(csp)) out.headers.set("content-security-policy", `${csp}; frame-ancestors 'self'`);
	return out;
}
