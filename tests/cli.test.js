import fs from "fs";
import path from "path";
import {expect, test, describe, beforeAll, afterAll} from "bun:test";

// Finding 5 (PR #34): the two enum flags (`--root-key`, `--mode`) must be validated up front. An
// invalid value must print a usage-style error to stderr (naming the flag, the bad value and the
// accepted set), exit non-zero, and emit no SQL — matching the existing loadMacros fail-fast pattern.
// Driven end-to-end by spawning the CLI, since the behaviour is process exit code + stderr + stdout.

const cliPath = path.join(import.meta.dir, "../src/cli.js");
const viewDir = path.join(import.meta.dir, ".tmp", "cli-test-views");

// Run the CLI as a child process, returning its exit code and captured streams.
async function runCli(args) {
	const proc = Bun.spawn(["bun", "run", cliPath, ...args], {stdout: "pipe", stderr: "pipe"});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return {exitCode, stdout, stderr};
}

describe("CLI enum-flag validation", () => {
	beforeAll(() => {
		fs.mkdirSync(viewDir, {recursive: true});
		const view = {resource: "Patient", select: [{column: [{name: "id", path: "id", type: "id"}]}]};
		fs.writeFileSync(path.join(viewDir, "patient.vd.json"), JSON.stringify(view));
	});
	afterAll(() => fs.rmSync(viewDir, {recursive: true, force: true}));

	test("invalid --root-key exits non-zero with a usage error and emits no SQL", async () => {
		const {exitCode, stdout, stderr} = await runCli(["--root-key", "uuidd", "-v", viewDir]);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("root-key");
		expect(stderr).toContain("uuidd");
		// The accepted set is listed.
		expect(stderr).toContain("natural");
		expect(stderr).toContain("uuid");
		// No SQL was emitted and no stack trace was printed.
		expect(stdout).not.toContain("SELECT");
		expect(stderr).not.toContain("at ");
	});

	test("invalid --mode exits non-zero with a usage error and emits no SQL", async () => {
		const {exitCode, stdout, stderr} = await runCli(["--mode", "bild", "-v", viewDir]);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("mode");
		expect(stderr).toContain("bild");
		expect(stderr).toContain("preview");
		expect(stdout).not.toContain("SELECT");
		expect(stderr).not.toContain("at ");
	});

	test("valid --root-key and --mode still compile and emit SQL", async () => {
		const {exitCode, stdout} = await runCli(["--root-key", "uuid", "--mode", "preview", "-v", viewDir]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("SELECT");
	});
});
