import { suggest } from "../src/sw/suggest";

export const onRequestGet: PagesFunction = async ({ request }) => {
  const q = new URL(request.url).searchParams.get("q");
  if (!q) return new Response("Missing q parameter", { status: 400 });
  return suggest(q, { provider: "default", trigger: "g", customUrl: null });
};
