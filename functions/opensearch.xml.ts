import { opensearch } from "../src/opensearch";

export const onRequestGet: PagesFunction = async ({ request }) => {
  return opensearch(new URL(request.url).origin);
};
