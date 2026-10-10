import { expect, it } from "vitest";
import { missingReleaseConfiguration, notarizationArguments } from "./macos-release-options.mjs";
const identity = "Developer ID Application: Fixture (TEAM)";
const fixture = { APPLE_SIGNING_IDENTITY: identity, APPLE_CERTIFICATE: "fixture-only", APPLE_CERTIFICATE_PASSWORD: "fixture-only", APPLE_API_KEY: "ID", APPLE_API_ISSUER: "ISSUER", APPLE_API_KEY_PATH: "/fixture/key.p8", TAURI_SIGNING_PRIVATE_KEY: "fixture-only" };
it("requires Developer ID, notarization and the existing updater key separately", () => {
  expect(missingReleaseConfiguration({}, "0 valid identities", () => false)).toHaveLength(4);
  expect(missingReleaseConfiguration(fixture, "0 valid identities", () => true)).toEqual([]);
});
it("rejects ad hoc and Apple Development identities for release", () => {
  for (const APPLE_SIGNING_IDENTITY of ["-", "Apple Development: Fixture"]) expect(missingReleaseConfiguration({ ...fixture, APPLE_SIGNING_IDENTITY }, "", () => true)).toContain("APPLE_SIGNING_IDENTITY (Developer ID Application)");
});
it("does not count a different installed certificate or missing private-key file", () => {
  const env = { ...fixture, APPLE_CERTIFICATE: undefined, APPLE_CERTIFICATE_PASSWORD: undefined };
  expect(missingReleaseConfiguration(env, '"Developer ID Application: Other"', () => false)).toHaveLength(2);
  expect(missingReleaseConfiguration(env, identity, () => true)).toEqual([]);
});
it("uses complete API credentials and supports the documented Apple ID alternative", () => {
  expect(notarizationArguments(fixture, () => true)).toEqual(["--key", "/fixture/key.p8", "--key-id", "ID", "--issuer", "ISSUER"]);
  expect(notarizationArguments({ APPLE_ID: "fixture@example.com", APPLE_PASSWORD: "fixture-only", APPLE_TEAM_ID: "TEAM" })).toContain("--team-id");
  expect(() => notarizationArguments({})).toThrow(/缺少公证/);
});
it("falls back to complete Apple ID credentials if the API key file is missing", () => {
  const env = { ...fixture, APPLE_ID: "fixture@example.com", APPLE_PASSWORD: "fixture-only", APPLE_TEAM_ID: "TEAM" };
  expect(missingReleaseConfiguration(env, "", () => false)).toEqual([]);
  expect(notarizationArguments(env, () => false)[0]).toBe("--apple-id");
});
