import { describe, expect, it } from "vitest";
import { assertOwnerAgentBackend } from "./agent-task-backend.js";

describe("owner-scoped agent backend admission", () => {
	it("rejects Modal before starting an owner agent with no trusted SDK gateway", () => {
		expect(() => assertOwnerAgentBackend("modal", "/run/viktor/owner-grant.json")).toThrow(
			"Owner agent requires local tool backend",
		);
	});
	it("permits owner agent local backend without changing existing non-owner Modal", () => {
		expect(() => assertOwnerAgentBackend("local", "/run/viktor/owner-grant.json")).not.toThrow();
		expect(() => assertOwnerAgentBackend("modal", undefined)).not.toThrow();
	});
});
