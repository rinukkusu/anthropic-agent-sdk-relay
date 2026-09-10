import { describe, expect, test } from "bun:test";
import { AsyncQueue } from "../src/relay/queue.ts";

describe("AsyncQueue", () => {
  test("delivers items pushed before the consumer starts", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();

    const seen: number[] = [];
    for await (const item of queue) seen.push(item);
    expect(seen).toEqual([1, 2]);
  });

  test("delivers items pushed while the consumer is waiting", async () => {
    const queue = new AsyncQueue<string>();
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const item of queue) seen.push(item);
    })();

    await Bun.sleep(5);
    queue.push("a");
    await Bun.sleep(5);
    queue.push("b");
    queue.close();
    await consumer;

    expect(seen).toEqual(["a", "b"]);
  });

  test("ignores pushes after close and ends the iterator", async () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    queue.push(99);
    const seen: number[] = [];
    for await (const item of queue) seen.push(item);
    expect(seen).toEqual([]);
  });
});
