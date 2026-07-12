/* Prints the CRC32C (hex) of a file using the product implementation in
   @onelight/core, so integration uploads are checksummed by the exact code
   the server verifies with. Run through tsx:

     node --import tsx scripts/crc32c-file.ts <path>
*/

import { readFile } from "node:fs/promises";
import process from "node:process";
import { crc32cHex } from "../packages/core/src/crc32c.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: node --import tsx scripts/crc32c-file.ts <path>");
  process.exit(2);
}

const bytes = await readFile(file);
console.log(crc32cHex(new Uint8Array(bytes)));
