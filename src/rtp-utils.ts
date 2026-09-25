// by @dgrief from @homebridge/camera-utils
import dgram from 'dgram'
import { randomBytes } from 'crypto'

const stunMagicCookie = 0x2112a442 // https://tools.ietf.org/html/rfc5389#section-6

export interface SrtpOptions {
  srtpKey: Buffer
  srtpSalt: Buffer
}

export interface RtpStreamOptions extends SrtpOptions {
  port: number
  rtcpPort: number
}

export interface RtpOptions {
  audio: RtpStreamOptions
  video: RtpStreamOptions
}

export interface RtpStreamDescription extends RtpStreamOptions {
  ssrc?: number
  iceUFrag?: string
  icePwd?: string
}

export interface RtpDescription {
  address: string
  audio: RtpStreamDescription
  video: RtpStreamDescription
  sdp: string
}

export function isRtpMessagePayloadType(payloadType: number) {
  return payloadType > 90 || payloadType === 0
}

export function getPayloadType(message: Buffer) {
  return message.readUInt8(1) & 0x7f
}

export function getSequenceNumber(message: Buffer) {
  return message.readUInt16BE(2)
}

export function isStunMessage(message: Buffer) {
  return message.length > 8 && message.readInt32BE(4) === stunMagicCookie
}

export function sendStunBindingRequest({
  rtpDescription,
  rtpSplitter,
  rtcpSplitter,
  localUfrag,
  type,
}: {
  rtpSplitter: dgram.Socket
  rtcpSplitter: dgram.Socket
  rtpDescription: RtpDescription
  localUfrag?: string
  type: 'audio' | 'video'
}) {
  const  remoteDescription = rtpDescription[type];
  if( remoteDescription.port == 0 )
    return;
  const { address } = rtpDescription,
    { port, rtcpPort } = remoteDescription

  // DS06M uses STUN binding packets as a lightweight UDP keepalive and does
  // not require an external STUN client library or server URL parser.
  const encodedMessage = createBindingRequest()
  try {
    rtpSplitter.send(encodedMessage as any, port, address)
  } catch (e) {
    console.error(e)
  }

  try {
    rtcpSplitter.send(encodedMessage as any, rtcpPort, address)
  } catch (e) {
    console.error(e)
  }
}

function createBindingRequest(): Buffer {
  const message = Buffer.alloc(20)
  message.writeUInt16BE(0x0001, 0)
  message.writeUInt16BE(0, 2)
  message.writeUInt32BE(stunMagicCookie, 4)
  const transactionId = randomBytes(12)
  for (let index = 0; index < transactionId.length; index++)
    message[8 + index] = transactionId[index]
  return message
}

function createBindingResponse(request: Buffer, address: string, port: number): Buffer {
  const family = address.includes(':') ? 0x02 : 0x01
  if (family !== 0x01)
    throw new Error('IPv6 STUN responses are not supported')

  const addressBytes = Buffer.from(address.split('.').map(Number))
  if (addressBytes.length !== 4)
    throw new Error('Invalid IPv4 address')

  const message = Buffer.alloc(32)
  message.writeUInt16BE(0x0101, 0)
  message.writeUInt16BE(12, 2)
  message.writeUInt32BE(stunMagicCookie, 4)
  for (let index = 0; index < 12; index++)
    message[8 + index] = request[8 + index]
  message.writeUInt16BE(0x0020, 20)
  message.writeUInt16BE(8, 22)
  message[24] = 0
  message[25] = family
  message.writeUInt16BE(port ^ (stunMagicCookie >>> 16), 26)
  const cookie = Buffer.alloc(4)
  cookie.writeUInt32BE(stunMagicCookie, 0)
  for (let index = 0; index < 4; index++)
    message[28 + index] = addressBytes[index] ^ cookie[index]
  return message
}

export function createStunResponder(rtpSplitter: dgram.Socket) {
  return rtpSplitter.on('message', (message, info) => {
    if (!isStunMessage(message)) {
      return null
    }

    try {
      const response = createBindingResponse(message, info.address, info.port)
      try {
        rtpSplitter.send(response as any, info.port, info.address)
      } catch (e) {
        console.error(e)
      }
    } catch (e) {
      console.debug('Failed to Decode STUN Message')
      console.debug(message.toString('hex'))
      console.debug(e)
    }

    return null
  })
}
