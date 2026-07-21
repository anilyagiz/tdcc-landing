export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
};
