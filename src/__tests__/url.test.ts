import { describe, it, expect } from "vitest";
import { fileUrlToLocalPath, splitUrlParts, urlHostPath } from "@/lib/url";

describe("fileUrlToLocalPath", () => {
  it("converts drive path and decodes Chinese filename", () => {
    const url = "file:///C:/Users/19145/Downloads/10.0.19.194/202607071638/cc-bridge/design/现代化UI升级-真实页面-全站高保真设计稿.html";
    expect(fileUrlToLocalPath(url)).toBe(
      "C:\\Users\\19145\\Downloads\\10.0.19.194\\202607071638\\cc-bridge\\design\\现代化UI升级-真实页面-全站高保真设计稿.html"
    );
  });

  it("decodes percent-encoded space", () => {
    expect(fileUrlToLocalPath("file:///C:/a%20b/c.txt")).toBe("C:\\a b\\c.txt");
  });

  it("keeps literal plus sign (not form-decoded)", () => {
    expect(fileUrlToLocalPath("file:///C:/a+b.txt")).toBe("C:\\a+b.txt");
  });

  it("converts UNC url to backslash share path", () => {
    expect(fileUrlToLocalPath("file://server/share/doc.txt")).toBe("\\\\server\\share\\doc.txt");
  });

  it("returns null for non-file schemes", () => {
    expect(fileUrlToLocalPath("https://example.com/a.html")).toBeNull();
    expect(fileUrlToLocalPath("ftp://host/a")).toBeNull();
  });

  it("returns null for invalid input", () => {
    expect(fileUrlToLocalPath("not a url")).toBeNull();
    expect(fileUrlToLocalPath("")).toBeNull();
  });

  it("falls back to raw path on malformed percent sequence", () => {
    expect(fileUrlToLocalPath("file:///C:/a%zz.html")).toBe("C:\\a%zz.html");
  });

  it("trims surrounding whitespace", () => {
    expect(fileUrlToLocalPath("  file:///D:/x.log  ")).toBe("D:\\x.log");
  });
});

describe("splitUrlParts / urlHostPath（回归）", () => {
  it("splits https url into protocol/host/segments/query/hash", () => {
    const parts = splitUrlParts("https://example.com/a/b?x=1&y=2#top");
    expect(parts).toEqual({
      protocol: "https://",
      host: "example.com",
      pathSegments: ["a", "b"],
      query: [["x", "1"], ["y", "2"]],
      hash: "#top",
    });
  });

  it("returns null for invalid url", () => {
    expect(splitUrlParts("plain text")).toBeNull();
  });

  it("urlHostPath concatenates host and pathname", () => {
    expect(urlHostPath("https://example.com/a/b?q=1")).toBe("example.com/a/b");
  });
});
