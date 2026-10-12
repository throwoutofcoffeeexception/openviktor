export function assertOwnerAgentBackend(
	backend: "local" | "modal",
	grantFile: string | undefined,
): void {
	if (grantFile && backend !== "local") {
		throw new Error("Owner agent requires local tool backend");
	}
}
