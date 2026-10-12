import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentGrantFile, readOwnerAgentBindingFile } from "./agent-task-auth.js";

const dirs: string[] = [];
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "viktor-grant-"));
	dirs.push(dir);
	const path = join(dir, "grant.json");
	writeFileSync(path, JSON.stringify({ token: "scoped-secret-012345678901234567890123", workspaceId: "ws-owner",
		principalId: "tg-123", expiresAt: Date.now() + 60_000 }), { mode: 0o400 });
	return path;
}

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("Viktor owner-scoped grant file", () => {
	it("reads only the bound owner identity and fails closed after grant removal", () => {
		const path = fixture();
		chmodSync(path, 0o600);
		writeFileSync(path, JSON.stringify({ workspaceId: "ws-owner", principalId: "tg-123" }), { mode: 0o400 });
		chmodSync(path, 0o400);
		const binding = readOwnerAgentBindingFile(path);
		expect(binding()).toEqual({ workspaceId: "ws-owner", principalId: "tg-123" });
		rmSync(path);
		expect(binding()).toBeNull();
	});
	it("rejects temporary grants as A2A service bindings", () => {
		expect(() => readOwnerAgentBindingFile(fixture())).toThrow("Binding shape invalid");
	});
	it("binds an exact token to its workspace and principal", () => {
		const lookup = readAgentGrantFile(fixture());
		expect(lookup("scoped-secret-012345678901234567890123")).toMatchObject({ workspaceId: "ws-owner", principalId: "tg-123" });
		expect(lookup("scoped-secrex")).toBeNull();
	});
	it("revokes the old bearer immediately when its grant file is removed or rotated", () => {
		const path = fixture();
		const lookup = readAgentGrantFile(path);
		const oldToken = "scoped-secret-012345678901234567890123";
		expect(lookup(oldToken)?.workspaceId).toBe("ws-owner");
		rmSync(path);
		expect(lookup(oldToken)).toBeNull();
		const nextToken = "scoped-secret-123456789012345678901234";
		writeFileSync(path, JSON.stringify({ token: nextToken, workspaceId: "ws-owner",
			principalId: "tg-123", expiresAt: Date.now() + 60_000 }), { mode: 0o400 });
		expect(lookup(oldToken)).toBeNull();
		expect(lookup(nextToken)?.workspaceId).toBe("ws-owner");
	});
	it("rejects writable, symlinked, and ambiguous grants", () => {
		const path = fixture();
		chmodSync(path, 0o644);
		expect(() => readAgentGrantFile(path)).toThrow();
		chmodSync(path, 0o400);
		const alias = `${path}.link`;
		symlinkSync(path, alias);
		expect(() => readAgentGrantFile(alias)).toThrow();
		chmodSync(path, 0o600);
		writeFileSync(path, JSON.stringify({ token: "scoped-secret-012345678901234567890123", workspaceId: "ws-owner",
			principalId: "tg-123", expiresAt: Date.now() + 60_000, admin: true }), { mode: 0o400 });
		expect(() => readAgentGrantFile(path)).toThrow();
	});
});
