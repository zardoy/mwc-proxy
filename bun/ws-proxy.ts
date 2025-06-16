import { Server, Socket, SocketHandler } from "bun";

const YOUR_SERVER_HOST = "localhost";
const YOUR_SERVER_PORT = 25565;
const THIS_WS_PORT = 80;
const THIS_PUBLIC_IP = "play.your-domain.com";

function createTCPConnection(handlers: SocketHandler<undefined, "buffer">) {
  return Bun.connect({
    hostname: YOUR_SERVER_HOST,
    port: YOUR_SERVER_PORT,
    socket: handlers,
  });
}

const DEBUG = false

const server = Bun.serve<{
    socket?: Socket;
    messageQueue?: (string | Buffer<ArrayBufferLike>)[];
}, {}>({
  port: THIS_WS_PORT,
  fetch(req, server) {
      if (server.upgrade(req, {
          data: {
              socket: undefined,
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
        ws.data.messageQueue.push(message);
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
            });
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
