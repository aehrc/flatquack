import {beforeAll, afterAll} from "bun:test";
import {openMemoryDb, runFixtureSuite} from "./test-util.js";

// Flatquack-specific fixtures in the SQL-on-FHIR test format, beyond the official conformance suite:
// the staged emitter's fork handling, the `repeat` directive, `%rowIndex`, reserved-name collisions,
// and repeat regressions. Same runner as the official suite (both root-key modes); these fixtures may
// also use the per-test `resources` extension (see runFixtureSuite in test-util.js).

let db;
beforeAll(done => { db = openMemoryDb(); done(); });
afterAll(done => { db.close(() => done()); });

runFixtureSuite({dir: "./custom-tests/", db: () => db});
