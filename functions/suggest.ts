import { handleSuggestRequest } from "../src/server/handlers";

interface RequestContext {
  env: { ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS?: string };
  request: Request;
}

export const onRequestGet = ({ env, request }: RequestContext) =>
  handleSuggestRequest(request, env);
