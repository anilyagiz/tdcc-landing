import { handleApi, scheduled, reportError } from "./api.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx);
    }

    if (url.pathname === "/" || !url.pathname.includes(".")) {
      const response = await env.ASSETS.fetch(request);
      if (response.status === 404) {
        const notFound = await env.ASSETS.fetch(new Request(
          new URL("/404.html", request.url)
        ));
        return new Response(notFound.body, {
          status: 404,
          headers: notFound.headers,
        });
      }
      return response;
    }

    return env.ASSETS.fetch(request);
  },

  // Expires rentals, cleans up old rows, and pays hosts (wrangler.toml [triggers]).
  async scheduled(_event, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil(scheduled(env).catch((err) => {
      console.error("scheduled job failed", err && err.stack ? err.stack : err);
      return reportError(env, err);
    }));
  },
};
