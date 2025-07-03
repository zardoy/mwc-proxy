import { Server, Socket, SocketHandler } from "bun";

const YOUR_SERVER_HOST = "example"
const YOUR_SERVER_PORT = 25565;
const THIS_WS_PORT = 80;
const THIS_PUBLIC_IP = "play.mcraft.fun"; // Replace with actual public IP

// Utility function to validate IP address
function isValidIPv4(ip: string): boolean {
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  return ipv4Regex.test(ip) && ip.split('.').every(octet => {
    const num = parseInt(octet, 10);
    return num >= 0 && num <= 255;
  });
}

function isValidIPv6(ip: string): boolean {
  const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::$|^::1$|^([0-9a-fA-F]{1,4}:){1,7}:$|^([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$|^([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}$|^([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}$|^([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}$|^([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}$|^[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})$|^:((:[0-9a-fA-F]{1,4}){1,7}|:)$/;
  return ipv6Regex.test(ip);
}

// Convert IPv6 string to bytes
function ipv6ToBytes(ip: string): Buffer {
  // Handle special cases
  if (ip === '::') return Buffer.alloc(16, 0);
  if (ip === '::1') {
    const bytes = Buffer.alloc(16, 0);
    bytes[15] = 1;
    return bytes;
  }

  const parts = ip.split(':');
  const bytes = Buffer.alloc(16);
  let j = 0;

  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') {
      // Skip empty parts (::)
      const remaining = parts.length - i - 1;
      j += (8 - remaining) * 2;
      continue;
    }
    const value = parseInt(parts[i], 16);
    bytes[j] = (value >> 8) & 0xff;
    bytes[j + 1] = value & 0xff;
    j += 2;
  }

  return bytes;
}

// Generate HAProxy PROXY protocol v2 header (binary format)
function createHAProxyProtocolHeader(remoteAddress: string, remotePort: number): Buffer {
  let sourceIP: Buffer;
  let destIP: Buffer;
  let addressFamily: number;
  let addressLength: number;

  if (isValidIPv4(remoteAddress)) {
    // IPv4 handling
    sourceIP = Buffer.from(remoteAddress.split('.').map(octet => parseInt(octet)));
    destIP = Buffer.from([127, 0, 0, 1]); // localhost
    addressFamily = 0x11; // IPv4, TCP
    addressLength = 12; // 4 (source IP) + 4 (dest IP) + 2 (source port) + 2 (dest port)
  } else if (isValidIPv6(remoteAddress)) {
    // IPv6 handling
    sourceIP = ipv6ToBytes(remoteAddress);
    destIP = Buffer.alloc(16); // ::1
    destIP[15] = 1;
    addressFamily = 0x21; // IPv6, TCP
    addressLength = 36; // 16 (source IP) + 16 (dest IP) + 2 (source port) + 2 (dest port)
  } else {
    // Fallback to IPv4 localhost if invalid
    sourceIP = Buffer.from([127, 0, 0, 1]);
    destIP = Buffer.from([127, 0, 0, 1]);
    addressFamily = 0x11;
    addressLength = 12;
  }

  // PROXY protocol v2 binary signature
  const signature = Buffer.from([0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A]);

  // Protocol version and command
  const version = 0x21; // version 2, PROXY command

  // Prepare source and destination ports
  const sourcePort = Buffer.alloc(2);
  sourcePort.writeUInt16BE(remotePort, 0);
  const destPort = Buffer.alloc(2);
  destPort.writeUInt16BE(YOUR_SERVER_PORT, 0);

  // Calculate address length
  const addressLengthBuffer = Buffer.alloc(2);
  addressLengthBuffer.writeUInt16BE(addressLength, 0);

  // Combine all parts of the PROXY protocol header
  return Buffer.concat([
    signature,
    Buffer.from([version, addressFamily]), // version and command
    addressLengthBuffer,
    sourceIP,
    destIP,
    sourcePort,
    destPort
  ]);
}

function createTCPConnection(handlers: SocketHandler<undefined, "buffer">, remoteAddress: string, remotePort: number) {
  return Bun.connect({
    hostname: YOUR_SERVER_HOST,
    port: YOUR_SERVER_PORT,
    socket: {
      ...handlers,
      open(socket) {
        // Write HAProxy PROXY protocol header before any data
        const proxyHeader = createHAProxyProtocolHeader(remoteAddress, remotePort);
        socket.write(proxyHeader);
        handlers.open?.(socket);
      }
    },
  });
}

const DEBUG = true

const server = Bun.serve<{
    socket?: Socket;
    remoteAddress?: string;
    remotePort?: number;
    messageQueue?: string[];
}, {}>({
  port: THIS_WS_PORT,
  fetch(req, server) {
    // Attempt to get real client IP and port from various headers
    const remoteAddress =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('cf-connecting-ip') ||
      req.headers.get('x-real-ip') ||
      '127.0.0.1';

    const remotePort =
      parseInt(req.headers.get('x-forwarded-port') || '') || 0;

    if (server.upgrade(req, {
      data: {
        socket: undefined,
        remoteAddress: remoteAddress,
        remotePort: remotePort
      },
    })) {
      return;
    }
    return new Response(null, {
      status: 302,
      headers: {
        "Location": `https://mcraft.fun/?ip=wss://${THIS_PUBLIC_IP}`,
        "X-Powered-By": "Bun"
      }
    });
  },
  websocket: {
    async message(ws, message) {
      // Initialize message queue if not present
      if (!ws.data.messageQueue) ws.data.messageQueue = [];
      if (!ws.data.socket) {
        // TCP socket not ready, queue the message
        ws.data.messageQueue.push(message as string);
        if (DEBUG) console.log('Queued message until TCP socket is ready', message);
      } else {
        // if (DEBUG) console.log('Sending message to TCP server', message)
        ws.data.socket.write(message);
      }
    },
    async open(ws) {
        try {
            if (DEBUG) console.log(`Attempting to connect to TCP server at ${YOUR_SERVER_HOST}:${YOUR_SERVER_PORT}`);
            const tcpSocket = await createTCPConnection({
                data(socket, data) {
                    ws.send(data);
                },
                error(socket, error) {
                    if (DEBUG) console.error('TCP socket error:', error);
                },
                end() {
                    if (DEBUG) console.log('TCP socket ended by remote');
                    ws.close();
                },
                close(socket) {
                    if (DEBUG) console.log('TCP socket closed')
                    ws.close();
                },
            }, ws.data.remoteAddress, ws.data.remotePort);
            if (DEBUG) console.log('TCP connection established successfully');
            ws.data.socket = tcpSocket;
            // Flush queued messages
            if (ws.data.messageQueue && ws.data.messageQueue.length > 0) {
              if (DEBUG) console.log('Flushing queued messages to TCP server', ws.data.messageQueue.length);
              for (const msg of ws.data.messageQueue) {
                tcpSocket.write(msg);
              }
              ws.data.messageQueue = [];
            }
        } catch (err) {
            console.error('Failed to connect to TCP server:', String(err));
            ws.close(1011, 'Failed to connect to TCP server');
        }
    },
    close(ws) {
        if (DEBUG) console.log('WebSocket closed')
        ws.data.socket?.end();
    },
  },
});

console.log(`WebSocket server running on ws://localhost:${THIS_WS_PORT}`);
