import { afterAll, beforeEach, spyOn } from "bun:test";

export function requestWithCookie(url: string, cookie?: string): Request {
  const headers = new Headers();
  if (cookie) {
    headers.set("Cookie", cookie);
  }
  return new Request(url, { headers });
}

export function installManagedFetchSpy(): ReturnType<
  typeof spyOn<typeof globalThis, "fetch">
> {
  const fetchSpy = spyOn(globalThis, "fetch");

  beforeEach(() => {
    fetchSpy.mockReset();
  });

  afterAll(() => {
    fetchSpy.mockRestore();
  });

  return fetchSpy;
}
