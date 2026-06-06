import { createHash } from "node:crypto";
import type { Socket } from "node:net";

const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptWebSocketKey(key: string) {
  return createHash("sha1").update(`${key}${WEB_SOCKET_GUID}`).digest("base64");
}

function encodeWebSocketText(payload: unknown) {
  const data = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  if (data.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
    return Buffer.concat([header, data]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(data.length), 2);
  return Buffer.concat([header, data]);
}

export function sendWebSocketText(socket: Socket, payload: unknown) {
  if (socket.destroyed) return;
  socket.write(encodeWebSocketText(payload));
}

export function sendWebSocketClose(socket: Socket) {
  if (socket.destroyed) return;
  socket.end(Buffer.from([0x88, 0]));
}

export function parseWebSocketFrames(
  socket: Socket,
  chunk: Buffer,
  buffered: Buffer,
  onMessage: (message: string | Buffer) => void,
) {
  let buffer = Buffer.concat([buffered, chunk]);
  while (buffer.length >= 2) {
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < offset + 2) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) break;
      const wideLength = buffer.readBigUInt64BE(offset);
      if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        sendWebSocketClose(socket);
        return Buffer.alloc(0);
      }
      length = Number(wideLength);
      offset += 8;
    }
    const maskLength = masked ? 4 : 0;
    if (buffer.length < offset + maskLength + length) break;
    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    buffer = buffer.subarray(offset + length);
    if (opcode === 0x8) {
      sendWebSocketClose(socket);
      return Buffer.alloc(0);
    }
    if (opcode === 0x9) {
      socket.write(Buffer.from([0x8a, 0]));
      continue;
    }
    if (opcode === 0x1) onMessage(payload.toString("utf8"));
    if (opcode === 0x2) onMessage(payload);
  }
  return buffer;
}
