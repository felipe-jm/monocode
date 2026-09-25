import { describe, expect, it } from "vitest";
import {
  applyCorrections,
  DICTATION_PROMPT_MAX,
  glossaryPrompt,
} from "./dictation";

describe("glossaryPrompt", () => {
  it("joins terms and skips blanks and comments", () => {
    expect(glossaryPrompt("# names\nTauri Studio\n\n  José  \n")).toBe(
      "Tauri Studio, José",
    );
  });

  it("drops whole trailing terms past the limit", () => {
    const term = "x".repeat(DICTATION_PROMPT_MAX - 5);
    expect(glossaryPrompt(`${term}\nlonger-than-five\nok`)).toBe(term);
  });
});

describe("applyCorrections", () => {
  it("replaces whole words regardless of case", () => {
    expect(
      applyCorrections(
        "O mono code roda; monocodex não.",
        "mono code => MonoCode\nmonocode => MonoCode",
      ),
    ).toBe("O MonoCode roda; monocodex não.");
  });

  it("treats accents as word characters and regex symbols literally", () => {
    expect(applyCorrections("éder e eder", "eder => Éder")).toBe("éder e Éder");
    expect(applyCorrections("use c++ hoje", "c++ => C++")).toBe("use C++ hoje");
  });

  it("ignores comments, lines without an arrow and literal $ in replacements", () => {
    expect(
      applyCorrections("custa dez", "# dez => 10\nsem seta\ndez => $&10"),
    ).toBe("custa $&10");
  });
});
