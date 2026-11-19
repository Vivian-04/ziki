import { describe, expect, it } from "vitest";
import {
  MAIN_BRANCH_PULL_NUMBER,
  previewBranch,
  previewUrl,
  projectPreviewUrl,
} from "./address";

describe("preview addresses", () => {
  it("matches the builder's branch naming for pull requests", () => {
    // Same as: printf '%s' "emerjent/ziki" | sha256sum | cut -c1-10
    expect(previewBranch("emerjent/ziki", 12)).toBe("pr-12-ec5a651ca4");
    expect(previewUrl("emerjent/ziki", 12)).toBe("https://pr-12-ec5a651ca4.ziki-previews.pages.dev");
  });

  it("gives each project one fixed main-branch address", () => {
    expect(MAIN_BRANCH_PULL_NUMBER).toBe(0);
    expect(projectPreviewUrl("vivian-04/preview-test")).toBe(
      "https://pr-0-4be3d73c20.ziki-previews.pages.dev",
    );
  });

  it("ignores letter case in the repository name", () => {
    expect(projectPreviewUrl("Vivian-04/Preview-Test")).toBe(projectPreviewUrl("vivian-04/preview-test"));
  });

  it("never clashes with a pull request's address", () => {
    expect(projectPreviewUrl("emerjent/ziki")).not.toBe(previewUrl("emerjent/ziki", 1));
  });

  it("uses another Pages project when given one", () => {
    expect(projectPreviewUrl("emerjent/ziki", "other-previews")).toBe(
      "https://pr-0-ec5a651ca4.other-previews.pages.dev",
    );
  });
});