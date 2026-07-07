import {expect, test, describe, beforeAll, afterAll} from "bun:test";
import fs from "fs";
import path from "path";

// Regression test for #42: `--mode run` intermittently segfaulted (exit 133,
// "NAPI FATAL ERROR") during Bun's teardown of the duckdb NAPI binding, AFTER
// the query had completed and the CSV was fully written. The fix is to run the
// CLI under node (its `#!/usr/bin/env node` shebang), which finalizes the same
// addon cleanly; bun cannot. The crash only shows up in a real spawned process
// at exit, so we exercise the CLI under node as a subprocess and require every
// run to exit cleanly with the correct output.

const cliPath = path.join(import.meta.dirname, "../src/cli.js");
const fixtureDir = path.join(import.meta.dirname, "cli-exit-fixture.temp");
const viewDir = path.join(fixtureDir, "views");

// ~12.5% crash rate was observed; 30 runs catches a regression with ~98%
// probability while keeping the test to a few seconds.
const RUNS = 30;
const EXPECTED_CSV = "id\np1\np2\np3\n";

beforeAll(() => {
	fs.mkdirSync(viewDir, {recursive: true});
	fs.writeFileSync(
		path.join(viewDir, "patient.vd.json"),
		JSON.stringify({
			name: "patients",
			resource: "Patient",
			select: [{column: [{path: "id", name: "id", type: "id"}]}],
		})
	);
	fs.writeFileSync(
		path.join(fixtureDir, "Patient.ndjson"),
		['{"resourceType":"Patient","id":"p1"}',
		 '{"resourceType":"Patient","id":"p2"}',
		 '{"resourceType":"Patient","id":"p3"}'].join("\n") + "\n"
	);
});

afterAll(() => {
	fs.rmSync(fixtureDir, {recursive: true, force: true});
});

describe("cli --mode run exit behavior (#42)", () => {
	test(`exits 0 with correct CSV across ${RUNS} runs`, () => {
		const failures = [];
		for (let i = 0; i < RUNS; i++) {
			const proc = Bun.spawnSync({
				cmd: [
					"node", cliPath,
					"--mode", "run",
					"--view-path", viewDir,
					"--view-pattern", "*.vd.json",
					"--template", "@csv",
				],
				cwd: fixtureDir,
				stdout: "pipe",
				stderr: "pipe",
			});

			const csv = fs.existsSync(path.join(fixtureDir, "patients.csv"))
				? fs.readFileSync(path.join(fixtureDir, "patients.csv"), "utf-8")
				: "<missing>";

			if (proc.exitCode !== 0 || csv !== EXPECTED_CSV) {
				failures.push(
					`run ${i}: exit=${proc.exitCode} signal=${proc.signalCode} ` +
					`csvOk=${csv === EXPECTED_CSV}`
				);
			}
		}
		expect(failures).toEqual([]);
	}, 60000);
});
