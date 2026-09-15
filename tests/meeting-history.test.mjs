import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mergeRecentMeetingHistory } from "../meeting-history.js";

function meeting(id, completedAt) {
  return {
    id,
    title: `Reunión ${id}`,
    url: `https://meet.example.test/${id}`,
    completed_at: completedAt,
  };
}

test("conserva únicamente las cinco reuniones más recientes", () => {
  const existing = [
    meeting("a", "2026-09-01T09:00:00.000Z"),
    meeting("b", "2026-09-02T09:00:00.000Z"),
  ];
  const completed = [
    meeting("c", "2026-09-03T09:00:00.000Z"),
    meeting("d", "2026-09-04T09:00:00.000Z"),
    meeting("e", "2026-09-05T09:00:00.000Z"),
    meeting("f", "2026-09-06T09:00:00.000Z"),
  ];

  const result = mergeRecentMeetingHistory(existing, completed);

  assert.deepEqual(result.map((item) => item.id), ["f", "e", "d", "c", "b"]);
  assert.equal(existing.length, 2);
  assert.equal(completed.length, 4);
  assert.notEqual(result[4], existing[1]);
});

test("actualiza una reunión repetida sin duplicarla", () => {
  const result = mergeRecentMeetingHistory(
    [meeting("same", "2026-09-01T09:00:00.000Z")],
    [{ ...meeting("same", "2026-09-07T09:00:00.000Z"), title: "Título actualizado" }],
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Título actualizado");
});

test("envía al final los registros sin fecha válida", () => {
  const result = mergeRecentMeetingHistory([
    meeting("invalid", "fecha-inválida"),
    meeting("valid", "2026-09-07T09:00:00.000Z"),
  ]);

  assert.deepEqual(result.map((item) => item.id), ["valid", "invalid"]);
});

test("el Worker solo expone el historial en la agenda autenticada", async () => {
  const source = await readFile(new URL("../worker.js", import.meta.url), "utf8");

  assert.match(source, /getAgenda\(env, \{ includeHistory: true \}\)/);
  assert.match(source, /if \(!includeHistory\) return agenda/);
  assert.match(source, /historyContainer/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.doesNotMatch(source, /data-meeting-id[^\n]+Abrir enlace/);
});
