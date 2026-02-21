import { opensearch } from "../src/opensearch";

export const onRequestGet: PagesFunction = ({ request }) => {
  return opensearch(new URL(request.url).origin);
};
