import { describe, it, expect } from "vitest";
import { portFromUrl, status } from "./engine-process.js";

describe("engine lifecycle helpers", () => {
  it("portFromUrl parses the port with sensible fallbacks", () => {
    expect(portFromUrl("http://localhost:8970")).toBe(8970);
    expect(portFromUrl("http://127.0.0.1:1234/")).toBe(1234);
    expect(portFromUrl("https://example.com")).toBe(443);
    expect(portFromUrl("garbage")).toBe(8970);
  });

  it("status reports running:false when nothing is listening", async () => {
    const r = await status("http://127.0.0.1:59999");
    expect(r.action).toBe("status");
    expect(r.running).toBe(false);
    expect(r.port).toBe(59999);
  });
});
