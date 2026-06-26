import { describe, expect, it } from "vitest";
import { MessageQueue } from "../index.js";

describe("MessageQueue", () => {
  it("drains one message at a time", () => {
    const q = new MessageQueue("one-at-a-time");
    q.enqueue("a");
    q.enqueue("b");

    expect(q.drain()).toEqual(["a"]);
    expect(q.drain()).toEqual(["b"]);
    expect(q.drain()).toEqual([]);
  });

  it("drains all messages", () => {
    const q = new MessageQueue("all");
    q.enqueue("a");
    q.enqueue("b");
    q.enqueue("c");

    expect(q.drain()).toEqual(["a", "b", "c"]);
    expect(q.drain()).toEqual([]);
  });

  it("tracks and clears pending messages", () => {
    const q = new MessageQueue();

    expect(q.hasItems).toBe(false);
    q.enqueue("x");
    expect(q.hasItems).toBe(true);
    q.clear();
    expect(q.hasItems).toBe(false);
    expect(q.drain()).toEqual([]);
  });
});
