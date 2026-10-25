import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { GithubClient, UpdateErr } from "./github.js";

type Step = Response | Error;

/** Fake fetch that replays the given steps in order and counts calls. */
function scripted(steps: Step[]) {
  const calls = { n: 0 };
  const fetchImpl = (async () => {
    const step = steps[Math.min(calls.n, steps.length - 1)];
    calls.n += 1;
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const client = (fetchImpl: typeof fetch) =>
  new GithubClient({
    apiBase: "http://127.0.0.1:9",
    repo: "owner/repo",
    allowHttp: true,
    fetchImpl,
    retryDelaysMs: [0, 0],
  });

describe("GithubClient.listReleases retries", () => {
  test("retries a 503 and then succeeds", async () => {
    const s = scripted([json(503, {}), json(502, {}), json(200, [])]);
    const res = await client(s.fetchImpl).listReleases();
    assert.equal(res.notModified, false);
    assert.equal(s.calls.n, 3);
  });

  test("gives up after 3 attempts on persistent 5xx", async () => {
    const s = scripted([json(500, {})]);
    await assert.rejects(client(s.fetchImpl).listReleases(), (e: unknown) => e instanceof UpdateErr && e.code === "bad-response");
    assert.equal(s.calls.n, 3);
  });

  test("retries network errors", async () => {
    const s = scripted([new TypeError("fetch failed"), json(200, [])]);
    const res = await client(s.fetchImpl).listReleases();
    assert.equal(res.releases.length, 0);
    assert.equal(s.calls.n, 2);
  });

  test("never retries a 404", async () => {
    const s = scripted([json(404, { message: "Not Found" })]);
    await assert.rejects(client(s.fetchImpl).listReleases(), (e: unknown) => e instanceof UpdateErr && e.code === "not-found");
    assert.equal(s.calls.n, 1);
  });

  test("a rate limit (403 with remaining 0) is reported once with the reset time", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    const s = scripted([json(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset })]);
    await assert.rejects(
      client(s.fetchImpl).listReleases(),
      (e: unknown) => e instanceof UpdateErr && e.code === "rate-limited" && e.resetAt === Number(reset) * 1000,
    );
    assert.equal(s.calls.n, 1);
  });

  test("304 with a cached listing returns the cache", async () => {
    const s = scripted([new Response(null, { status: 304, headers: { etag: '"abc"' } })]);
    const res = await client(s.fetchImpl).listReleases({ etag: '"abc"', releases: [] as never });
    assert.equal(res.notModified, true);
    assert.equal(s.calls.n, 1);
  });
});
