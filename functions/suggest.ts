import { parseCookie, suggest } from "../src/suggest";

export const onRequestGet: PagesFunction = ({ request }) => {
  const q = new URL(request.url).searchParams.get("q");
  if (!q) {
    return new Response("Missing q parameter", { status: 400 });
  }
  return suggest(q, parseCookie(request));
};
