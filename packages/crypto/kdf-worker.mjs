// Argon2id in a worker thread: memory-hard hashing must never block the server's event loop.
import { parentPort } from "node:worker_threads";
import { argon2id } from "hash-wasm";
parentPort.on("message", async ({ id, password, salt, iterations, parallelism, memorySize }) => {
  try {
    const out = await argon2id({ password, salt: Buffer.from(salt, "base64"), iterations, parallelism, memorySize, hashLength: 32, outputType: "binary" });
    parentPort.postMessage({ id, key: Buffer.from(out).toString("base64") });
    parentPort.close(); // one job per worker: let it exit
  } catch (e) {
    parentPort.postMessage({ id, error: String(e?.message ?? e) });
    parentPort.close();
  }
});
