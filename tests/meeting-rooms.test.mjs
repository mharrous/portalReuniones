import assert from "node:assert/strict";
import test from "node:test";

import { buildMeetingNotification, findMeetingConflict, meetingModality, meetingRoomId } from "../worker.js";

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

test("conserva como videoconferencia las reuniones antiguas con enlace", () => {
  assert.equal(meetingModality({ ...baseMeeting, url: "https://teams.microsoft.com/example" }), "videoconferencia");
});

test("respeta la modalidad presencial seleccionada", () => {
  assert.equal(meetingModality({ ...baseMeeting, modality: "presencial", url: "" }), "presencial");
});

test("genera un correo con todos los detalles de la reserva", () => {
  const notification = buildMeetingNotification({
    ...baseMeeting,
    title: "Comité de dirección",
    room: "sala-orientacion",
    modality: "videoconferencia",
    url: "https://teams.microsoft.com/example",
    notes: "Revisar resultados",
  }, "Mustafa", "created");

  assert.match(notification.subject, /Comité de dirección/);
  assert.match(notification.text, /Sala Orientación/);
  assert.match(notification.text, /Videoconferencia/);
  assert.match(notification.text, /Mustafa/);
  assert.match(notification.text, /https:\/\/teams\.microsoft\.com\/example/);
});

test("el correo presencial no incluye botón para unirse", () => {
  const notification = buildMeetingNotification({
    ...baseMeeting,
    title: "Atención presencial",
    modality: "presencial",
    url: "",
  });

  assert.doesNotMatch(notification.html, /Unirse a la reunión/);
  assert.match(notification.text, /Modalidad: Presencial/);
});
