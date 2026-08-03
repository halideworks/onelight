import { describe, expect, it } from "vitest";
import { amzDate, presignS3Url } from "./sigv4.js";

/* AWS publishes a worked example for presigned URLs, with every intermediate
   value and the final signature. It is the only way to know this is right
   without a bucket and a network: SigV4 fails closed and identically for a
   wrong key, a wrong escape, an unsorted query and a mis-signed header, so
   "it returned something that looks like a signature" proves nothing. */
const EXAMPLE = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  host: "examplebucket.s3.amazonaws.com",
};

describe("SigV4 presigned URLs", () => {
  it("matches the signature AWS documents for its own example", async () => {
    const url = await presignS3Url(EXAMPLE, "GET", "test.txt", {
      expiresIn: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toContain(
      "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("puts the query in the order the signature was computed over", async () => {
    const url = await presignS3Url(EXAMPLE, "GET", "test.txt", {
      expiresIn: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    const query = new URL(url).search;
    expect(query.indexOf("X-Amz-Algorithm")).toBeLessThan(
      query.indexOf("X-Amz-Credential"),
    );
    expect(query.indexOf("X-Amz-Credential")).toBeLessThan(
      query.indexOf("X-Amz-Date"),
    );
    expect(query.indexOf("X-Amz-Date")).toBeLessThan(
      query.indexOf("X-Amz-Expires"),
    );
  });

  it("signs a different signature for a different key", async () => {
    const one = await presignS3Url(EXAMPLE, "GET", "test.txt", {
      expiresIn: 3600,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    const two = await presignS3Url(EXAMPLE, "GET", "other.txt", {
      expiresIn: 3600,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(one).not.toBe(two);
  });

  it("signs a different signature for a different method", async () => {
    const get = await presignS3Url(EXAMPLE, "GET", "test.txt", {
      expiresIn: 3600,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    const put = await presignS3Url(EXAMPLE, "PUT", "test.txt", {
      expiresIn: 3600,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    /* A read capability that could be replayed as a write would undo the
       whole point of signing the direction. */
    expect(get).not.toBe(put);
  });

  it("escapes a key the way AWS canonicalises it", async () => {
    const url = await presignS3Url(
      EXAMPLE,
      "GET",
      "renditions/version 1/proxy+1080.mp4",
      { expiresIn: 3600, now: new Date("2013-05-24T00:00:00Z") },
    );
    /* Slashes stay literal in a path; everything outside the unreserved set
       is percent-encoded, including the plus and the space that
       encodeURIComponent would leave or encode differently. */
    expect(url).toContain("/renditions/version%201/proxy%2B1080.mp4");
  });

  it("formats the timestamp the way AWS does", () => {
    expect(amzDate(new Date("2013-05-24T00:00:00Z"))).toEqual({
      stamp: "20130524T000000Z",
      date: "20130524",
    });
  });
});
