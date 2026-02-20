export function opensearch(origin: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>flashbang</ShortName>
  <Description>1ms local first duck-duck-go style bang redirects</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Image width="16" height="16" type="image/svg+xml">${origin}/icon.svg</Image>
  <Url type="text/html" template="${origin}/?q={searchTerms}"/>
  <Url type="application/x-suggestions+json" template="${origin}/suggest?q={searchTerms}"/>
</OpenSearchDescription>`,
    {
      headers: { "Content-Type": "application/opensearchdescription+xml" },
    },
  );
}
