import { handleApi, scheduled, scheduledMinute, reportError } from "./api.js";
import { handleGateway, isGatewayPath } from "./gateway.js";
import { handleV1, isApiPath } from "./billing.js";

// wrangler.toml [triggers]: the 10-minute jobs plus a cheap every-minute one.
const MINUTE_CRON = "* * * * *";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (isApiPath(url.pathname)) {
      return handleV1(request, env, ctx);
    }

    if (isGatewayPath(url.pathname)) {
      return handleGateway(request, env);
    }

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
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const job = event && event.cron === MINUTE_CRON ? scheduledMinute : scheduled;
    ctx.waitUntil(job(env).catch((err) => {
      console.error("scheduled job failed", err && err.stack ? err.stack : err);
      return reportError(env, err);
    }));
  },
};
