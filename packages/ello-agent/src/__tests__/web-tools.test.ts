import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentContext, LocalEnvironment, WebFetchTool, WebSearchTool } from "../index.js";

function makeCtx() {
  return { deps: new AgentContext({ env: new LocalEnvironment() }) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("WebFetchTool", () => {
  it("fetches and strips html", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<html><body><h1>Hello</h1><script>x</script></body></html>", {
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const result = await new WebFetchTool().call(makeCtx(), {
      url: "https://example.com",
      maxLength: 100,
    });

    expect(result).toContain("Hello");
    expect(result).not.toContain("script");
  });

  it("truncates long content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("abcdef", {
          headers: { "content-type": "text/plain" },
        }),
      ),
    );

    const result = await new WebFetchTool().call(makeCtx(), {
      url: "https://example.com",
      maxLength: 3,
    });

    expect(result).toContain("abc");
    expect(result).toContain("truncated");
  });
});

describe("WebSearchTool", () => {
  it("requires api key", async () => {
    await expect(new WebSearchTool().call(makeCtx(), { query: "hello" })).resolves.toContain(
      "SEARCH_API_KEY",
    );
  });

  it("formats search results", async () => {
    vi.stubEnv("SEARCH_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          web: {
            results: [
              {
                title: "Example",
                url: "https://example.com",
                description: "Example description",
              },
            ],
          },
        }),
      ),
    );

    const result = await new WebSearchTool().call(makeCtx(), {
      query: "example",
      maxResults: 1,
    });

    expect(result).toContain("[Example](https://example.com)");
    expect(result).toContain("Example description");
  });
});
