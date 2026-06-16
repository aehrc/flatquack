import {beforeAll, afterAll} from "bun:test";
import {openMemoryDb, runFixtureSuite} from "./test-util.js";

// Official SQL-on-FHIR conformance suite (mirror of FHIR/sql-on-fhir.js /tests). Do not edit the
// fixtures under spec-tests/ — flatquack-specific cases live in custom-tests/ (see custom.staged.test.js).
// Every fixture runs through the staged (hybrid) emitter in both root-fork key modes.

let db;
beforeAll(done => { db = openMemoryDb(); done(); });
afterAll(done => { db.close(() => done()); });

runFixtureSuite({dir: "./spec-tests/", db: () => db});
