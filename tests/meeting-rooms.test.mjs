import assert from "node:assert/strict";
import test from "node:test";

import { findMeetingConflict, meetingRoomId } from "../worker.js";

const baseMeeting = {
  id: "meeting-1",
  date: "2099-10-20",
  time: "10:00",
  duration: 60,
};

test("permite reservar ambas salas en el mismo horario", () => {
  const meetings = [{ ...baseMeeting, room: "sala-pleno" }];
  const candidate = { ...baseMeeting, id: "meeting-2", room: "sala-orientacion" };

  assert.equal(findMeetingConflict(meetings, candidate), null);
});

test("bloquea dos reservas solapadas en la misma sala", () => {
  const meetings = [{ ...baseMeeting, room: "sala-pleno" }];
  const candidate = { ...baseMeeting, id: "meeting-2", time: "10:30", room: "sala-pleno" };

  assert.equal(findMeetingConflict(meetings, candidate)?.id, "meeting-1");
});

test("asigna las reuniones antiguas sin sala a Sala Pleno", () => {
  assert.equal(meetingRoomId(baseMeeting), "sala-pleno");
});
