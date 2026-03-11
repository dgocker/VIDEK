import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';

const PORT = process.env.PORT || 3000;
const SECRET_TOKEN = process.env.RELAY_TOKEN || 'super-secret-anti-dpi-token-2026';

async function startServer() {
  const app = express();
  const server = http.createServer(app);

  // 1. МАСКИРОВКА (Camouflage)
  // Если сканер РКН зайдет на API, он увидит скучную заглушку.
  app.get('/api/v2/metrics', (req, res) => {
    res.send(`
      <html>
        <head><title>Weather API v2</title></head>
        <body style="font-family: monospace; padding: 20px;">
          <h1>Weather Data Aggregator API</h1>
          <p>Status: Operational</p>
          <p>Endpoint: /api/v2/metrics</p>
        </body>
      </html>
    `);
  });

  // Vite middleware for development (serves the React app)
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  // 2. ЗАЩИЩЕННЫЙ WEBSOCKET СЕРВЕР
  const wss = new WebSocketServer({ noServer: true });

  // Хранилище комнат: roomId -> Set(ws)
  const rooms = new Map();

  // Перехватываем попытку апгрейда до WebSocket
  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      const token = url.searchParams.get('token');

      // Проверяем секретный путь и токен
      if (url.pathname.startsWith('/secure-relay') && token === SECRET_TOKEN) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } else {
        // Если это сканер или неверный токен - обрываем соединение
        socket.destroy();
      }
    } catch (e) {
      socket.destroy();
    }
  });

  wss.on('connection', (ws, request) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    const roomId = url.searchParams.get('room');

    if (!roomId) {
      ws.close();
      return;
    }

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    rooms.get(roomId).add(ws);

    // 3. СЛЕПАЯ РЕТРАНСЛЯЦИЯ (Сам "TURN")
    ws.on('message', (message, isBinary) => {
      const roomClients = rooms.get(roomId);
      if (roomClients) {
        roomClients.forEach((client) => {
          if (client !== ws && client.readyState === 1 /* OPEN */) {
            client.send(message, { binary: isBinary });
          }
        });
      }
    });

    ws.on('close', () => {
      const roomClients = rooms.get(roomId);
      if (roomClients) {
        roomClients.delete(ws);
        if (roomClients.size === 0) {
          rooms.delete(roomId);
        }
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`Camouflaged Relay Server running on port ${PORT}`);
  });
}

startServer();
