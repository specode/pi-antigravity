import assert from "node:assert/strict";
import test from "node:test";
import * as publicConverters from "@earendil-works/pi-ai/api/google-shared";
import { convertMessages, convertTools, mapToolChoice } from "../src/google-shared.ts";

test("host resolution reuses the public converter functions instead of vendoring Pi", () => {
  assert.equal(convertMessages, publicConverters.convertMessages);
  assert.equal(convertTools, publicConverters.convertTools);
  assert.equal(mapToolChoice, publicConverters.mapToolChoice);
});

test("the host converter retains the public tool-choice and empty-tools behavior", () => {
  assert.equal(mapToolChoice("auto"), publicConverters.mapToolChoice("auto"));
  assert.equal(mapToolChoice("none"), publicConverters.mapToolChoice("none"));
  assert.deepEqual(convertTools([], true, false), publicConverters.convertTools([], true, false));
});
