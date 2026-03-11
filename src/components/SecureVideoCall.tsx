import React, { useEffect, useRef, useState } from 'react';

// Настройки нашего сервера
// В продакшене это будет wss://твое-имя.onrender.com/secure-relay
// Для локальной разработки используем текущий хост
const RELAY_TOKEN = import.meta.env.VITE_RELAY_TOKEN || 'super-secret-anti-dpi-token-2026';

export default function SecureVideoCall() {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const [roomId, setRoomId] = useState('test-room-1');
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  useEffect(() => {
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (mediaRecorderRef.current) mediaRecorderRef.current.stop();
    };
  }, []);

  const connectToRelay = () => {
    if (wsRef.current) wsRef.current.close();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const RELAY_SERVER_URL = `${protocol}//${host}/secure-relay`;

    const secureWsUrl = `${RELAY_SERVER_URL}?room=${roomId}&token=${RELAY_TOKEN}`;
    const socket = new WebSocket(secureWsUrl);
    socket.binaryType = 'arraybuffer';
    wsRef.current = socket;

    socket.onopen = () => {
      console.log('Connected to Secure Relay');
      setIsConnected(true);
      setupMediaSource(socket);
    };

    socket.onclose = () => {
      console.log('Disconnected from Secure Relay');
      setIsConnected(false);
      setIsStreaming(false);
    };
    
    socket.onerror = (error) => {
        console.error("WebSocket Error:", error);
    }
  };

  const setupMediaSource = (socket: WebSocket) => {
    const mediaSource = new MediaSource();
    if (remoteVideoRef.current) {
      remoteVideoRef.current.src = URL.createObjectURL(mediaSource);
    }

    mediaSource.addEventListener('sourceopen', () => {
      try {
        // Используем кодек VP8 (он хорошо поддерживается)
        const sourceBuffer = mediaSource.addSourceBuffer('video/webm; codecs="vp8, opus"');
        sourceBufferRef.current = sourceBuffer;

        // Очередь для пакетов, если буфер занят
        const queue: ArrayBuffer[] = [];
        let isAppending = false;

        const processQueue = () => {
          if (queue.length > 0 && !isAppending && !sourceBuffer.updating) {
            isAppending = true;
            const data = queue.shift();
            if (data) {
                try {
                    sourceBuffer.appendBuffer(data);
                } catch (e) {
                    console.error("Error appending buffer", e);
                    isAppending = false;
                }
            }
          }
        };

        sourceBuffer.addEventListener('updateend', () => {
          isAppending = false;
          processQueue();
        });

        socket.onmessage = (event) => {
          // 3. СНИМАЕМ ОБФУСКАЦИЮ (Удаляем мусорный паддинг)
          const unpaddedData = removePadding(event.data);
          
          queue.push(unpaddedData);
          processQueue();
        };
      } catch (e) {
        console.error("Error setting up MediaSource", e);
      }
    });
  };

  const startStreaming = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      // Нарезаем поток на чанки
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs="vp8, opus"' });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = async (event) => {
        if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          const buffer = await event.data.arrayBuffer();
          
          // 4. ДОБАВЛЯЕМ ОБФУСКАЦИЮ (Мусорные байты для обмана DPI)
          const paddedData = addPadding(buffer);
          wsRef.current.send(paddedData);
        }
      };

      // Отправляем чанки каждые 200мс (баланс между задержкой и нагрузкой)
      recorder.start(200);
      setIsStreaming(true);
    } catch (err) {
      console.error('Error accessing media devices:', err);
      alert('Could not access camera/microphone. Please check permissions.');
    }
  };

  const stopStreaming = () => {
      if (mediaRecorderRef.current) {
          mediaRecorderRef.current.stop();
      }
      if (localVideoRef.current && localVideoRef.current.srcObject) {
          const stream = localVideoRef.current.srcObject as MediaStream;
          stream.getTracks().forEach(track => track.stop());
          localVideoRef.current.srcObject = null;
      }
      setIsStreaming(false);
  }

  // --- ФУНКЦИИ ОБФУСКАЦИИ (ANTI-DPI) ---

  // Структура пакета: [4 байта: размер оригинала] + [Оригинальные данные] + [Случайный мусор]
  const addPadding = (originalBuffer: ArrayBuffer) => {
    const originalView = new Uint8Array(originalBuffer);
    const originalSize = originalView.length;
    
    // Генерируем случайный размер мусора от 500 до 5000 байт
    const paddingSize = Math.floor(Math.random() * 4500) + 500; 
    const totalSize = 4 + originalSize + paddingSize;
    
    const paddedBuffer = new ArrayBuffer(totalSize);
    const paddedView = new DataView(paddedBuffer);
    const paddedUint8 = new Uint8Array(paddedBuffer);

    // Пишем размер оригинала в первые 4 байта
    paddedView.setUint32(0, originalSize, true); // true = little-endian
    
    // Копируем оригинальные данные
    paddedUint8.set(originalView, 4);
    
    // Заполняем остаток случайным мусором
    for (let i = 4 + originalSize; i < totalSize; i++) {
      paddedUint8[i] = Math.floor(Math.random() * 256);
    }
    
    return paddedBuffer;
  };

  const removePadding = (paddedBuffer: ArrayBuffer) => {
    const paddedView = new DataView(paddedBuffer);
    // Читаем размер оригинала из первых 4 байт
    const originalSize = paddedView.getUint32(0, true);
    
    // Извлекаем только оригинальные данные, отбрасывая мусор
    return paddedBuffer.slice(4, 4 + originalSize);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <h2 className="text-xl font-semibold mb-4">Secure Relay Connection</h2>
        <div className="flex gap-4 items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">Room ID</label>
            <input 
              type="text" 
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              disabled={isConnected}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
          <button 
            onClick={isConnected ? () => wsRef.current?.close() : connectToRelay}
            className={`px-6 py-2 rounded-lg font-medium text-white transition-colors ${
              isConnected 
                ? 'bg-red-500 hover:bg-red-600' 
                : 'bg-indigo-600 hover:bg-indigo-700'
            }`}
          >
            {isConnected ? 'Disconnect' : 'Connect to Relay'}
          </button>
        </div>
        
        {isConnected && (
            <div className="mt-4 pt-4 border-t border-gray-100">
                <button
                    onClick={isStreaming ? stopStreaming : startStreaming}
                    className={`px-6 py-2 rounded-lg font-medium text-white transition-colors ${
                        isStreaming
                            ? 'bg-orange-500 hover:bg-orange-600'
                            : 'bg-emerald-500 hover:bg-emerald-600'
                    }`}
                >
                    {isStreaming ? 'Stop Camera' : 'Start Camera & Stream'}
                </button>
            </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-gray-900 rounded-xl overflow-hidden aspect-video relative shadow-md">
          <div className="absolute top-2 left-2 bg-black/50 text-white px-2 py-1 rounded text-xs z-10">
            Local Camera
          </div>
          <video 
            ref={localVideoRef} 
            autoPlay 
            muted 
            playsInline 
            className="w-full h-full object-cover"
          />
        </div>
        <div className="bg-gray-900 rounded-xl overflow-hidden aspect-video relative shadow-md">
          <div className="absolute top-2 left-2 bg-black/50 text-white px-2 py-1 rounded text-xs z-10 flex items-center gap-2">
            Remote Stream
            <span className="flex h-2 w-2">
              <span className={`animate-ping absolute inline-flex h-2 w-2 rounded-full opacity-75 ${isConnected ? 'bg-emerald-400' : 'bg-red-400'}`}></span>
              <span className={`relative inline-flex rounded-full h-2 w-2 ${isConnected ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
            </span>
          </div>
          <video 
            ref={remoteVideoRef} 
            autoPlay 
            playsInline 
            className="w-full h-full object-cover"
          />
        </div>
      </div>
    </div>
  );
}
