import { describe, expect, it } from "vitest";
import { parseStandaloneHttpUrl, parseUserMessageLinks, type UserLink } from "./linkPreview";

describe("parseStandaloneHttpUrl", () => {
  it("normalizes a standalone web URL for display", () => {
    expect(
      parseStandaloneHttpUrl(
        "  https://www.example.com/docs/start?q=one#intro  ",
      ),
    ).toEqual({
      url: "https://www.example.com/docs/start?q=one#intro",
      host: "example.com",
      displayUrl: "example.com/docs/start?q=one#intro",
    });
  });

  it("keeps a root URL compact", () => {
    expect(parseStandaloneHttpUrl("http://example.com/")?.displayUrl).toBe(
      "example.com",
    );
  });

  it("does not turn prose or credentialed URLs into preview cards", () => {
    expect(
      parseStandaloneHttpUrl("take a look at https://example.com"),
    ).toBeNull();
    expect(
      parseStandaloneHttpUrl("https://person:secret@example.com"),
    ).toBeNull();
    expect(parseStandaloneHttpUrl("file:///tmp/example.html")).toBeNull();
  });
});

function firstLink(text: string): UserLink | undefined {
  return parseUserMessageLinks(text)?.find(
    (part): part is UserLink => typeof part !== "string",
  );
}

describe("parseUserMessageLinks", () => {
  it("extracts a URL followed by a comment", () => {
    expect(
      parseUserMessageLinks(
        "https://github.com/hardbeat920/monocode/pull/226 check this",
      ),
    ).toEqual([
      {
        url: "https://github.com/hardbeat920/monocode/pull/226",
        host: "github.com",
        displayUrl: "github.com/hardbeat920/monocode/pull/226",
        githubWorkItem: {
          kind: "pr",
          repo: "hardbeat920/monocode",
          number: 226,
        },
      },
      " check this",
    ]);
  });

  it("links every URL in the message, not only the first", () => {
    const parts = parseUserMessageLinks(
      "1. https://github.com/acme/api/pull/3311\n2. https://github.com/acme/api/pull/3312\n3. https://github.com/acme/mobile/pull/49\nrevise",
    );
    expect(
      parts?.map((part) =>
        typeof part === "string" ? part : part.githubWorkItem?.number,
      ),
    ).toEqual(["1. ", 3311, "\n2. ", 3312, "\n3. ", 49, "\nrevise"]);
  });

  it("recognizes GitHub issues and links to a PR subpage", () => {
    expect(
      firstLink("https://github.com/acme/widgets/issues/42#issuecomment-1")
        ?.githubWorkItem,
    ).toEqual({ kind: "issue", repo: "acme/widgets", number: 42 });
    expect(
      firstLink("https://www.github.com/acme/widgets/pull/73/files")
        ?.githubWorkItem,
    ).toEqual({ kind: "pr", repo: "acme/widgets", number: 73 });
  });

  it("leaves other GitHub URLs as normal web links", () => {
    expect(
      firstLink("https://github.com/acme/widgets/actions")?.githubWorkItem,
    ).toBeUndefined();
    expect(
      firstLink("https://github.com/acme/widgets/issues/0")?.githubWorkItem,
    ).toBeUndefined();
  });

  it("preserves prose around a URL and drops sentence punctuation", () => {
    const parts = parseUserMessageLinks(
      "Please review (https://example.com/docs), thanks",
    );
    expect(parts?.[0]).toBe("Please review (");
    expect((parts?.[1] as UserLink).url).toBe("https://example.com/docs");
    expect(parts?.[2]).toBe("), thanks");
  });

  it("returns null when there is no valid web URL", () => {
    expect(parseUserMessageLinks("Nothing to preview here")).toBeNull();
  });
});
